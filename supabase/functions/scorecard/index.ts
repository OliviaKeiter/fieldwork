// Supabase Edge Function: scorecard
//
// Scores a single job description against the stored fw_profile (the "ceiling" — see
// SPEC.md principle #1: every AI action reads the career record from the database and
// nothing generated may exceed it). Accepts POST body { jd_text } and/or { url }.
//
// Flow: read fw_profile + fw_settings first -> liveness check if a url was given (best
// effort) -> extract comp/location/reqs from the JD text -> call Claude for a verdict in
// the order comp -> location -> contract -> blockers -> degree (resume-builder
// methodology) -> return the verdict card JSON.
//
// Model: fw_settings.models.scorecard, falling back to fw_settings.models.default, falling
// back to the hardcoded default 'claude-sonnet-5' (per SPEC.md §2). Never hardcode a
// candidate fact/threshold here — everything candidate-specific comes from fw_profile.
//
// Requires the Supabase secret ANTHROPIC_API_KEY (`supabase secrets set
// ANTHROPIC_API_KEY=sk-ant-...` or set via the dashboard's Edge Function secrets panel).
// The key is read from Deno.env only — never hardcoded, never echoed to the client.

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export type Grade = "A+" | "A" | "B" | "C" | "D" | "F";

export interface VerdictResult {
  grade: Grade;
  company: string | null;
  title: string | null;
  comp_min: number | null;
  comp_max: number | null;
  remote_type: string | null;
  location: string | null;
  pain_line: string | null;
  gaps: string[];
  reasoning: string;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface LivenessResult {
  checked: boolean;
  likely_expired: boolean;
  note: string;
  pageText: string | null;
}

/** schema.org JobPosting fields worth trusting over page copy. */
export interface JobPostingMeta {
  validThrough: string | null;
  datePosted: string | null;
}

/** Walks a parsed JSON-LD value (object, array, or @graph wrapper) for the first
 * JobPosting node and returns its date fields. */
function findJobPosting(node: unknown): JobPostingMeta | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findJobPosting(item);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;

  const type = obj["@type"];
  const isJobPosting = Array.isArray(type)
    ? type.some((t) => String(t) === "JobPosting")
    : String(type) === "JobPosting";
  if (isJobPosting) {
    return {
      validThrough: typeof obj.validThrough === "string" ? obj.validThrough : null,
      datePosted: typeof obj.datePosted === "string" ? obj.datePosted : null,
    };
  }
  if (obj["@graph"]) return findJobPosting(obj["@graph"]);
  return null;
}

/** Pulls schema.org JobPosting metadata out of a page's ld+json blocks. Job boards (Built
 * In, Greenhouse, Lever, LinkedIn) publish `validThrough` here and then keep serving expired
 * postings at HTTP 200 with no "expired" copy anywhere on the page — so on most listings
 * this is the only honest expiry signal there is. */
export function extractJobPostingMeta(rawBody: string): JobPostingMeta | null {
  // Deliberately loose on the type attribute: Built In serves it HTML-escaped as
  // `application/ld&#x2B;json`, so matching a literal "ld+json" finds nothing. Anything
  // ld…json shaped gets parsed; non-JobPosting blocks are ignored below anyway.
  const blocks = rawBody.matchAll(
    /<script[^>]*type=["'][^"']*ld[^"']*json[^"']*["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const block of blocks) {
    try {
      const found = findJobPosting(JSON.parse(block[1].trim()));
      if (found) return found;
    } catch {
      // Malformed ld+json block — skip it and try the next.
    }
  }
  return null;
}

/** Best-effort liveness check: a real 404/410, a schema.org `validThrough` already in the
 * past, or common "posting expired" copy. Anything else (including a fetch failure) is
 * reported but never blocks scoring — the JD text the user pasted or the page text we could
 * fetch is still worth scoring. */
export async function checkLiveness(url: string): Promise<LivenessResult> {
  try {
    const res = await fetch(url, { redirect: "follow" });
    const status = res.status;
    const rawBody = await res.text();
    const pageText = stripHtml(rawBody).slice(0, 15000);
    if (status === 404 || status === 410) {
      return { checked: true, likely_expired: true, note: `HTTP ${status} — posting likely removed.`, pageText };
    }

    const meta = extractJobPostingMeta(rawBody);
    if (meta?.validThrough) {
      const expiry = new Date(meta.validThrough);
      if (!Number.isNaN(expiry.getTime()) && expiry.getTime() < Date.now()) {
        return {
          checked: true,
          likely_expired: true,
          note: `Posting expired ${meta.validThrough.slice(0, 10)} (schema.org validThrough)${
            meta.datePosted ? `, posted ${meta.datePosted.slice(0, 10)}` : ""
          }.`,
          pageText,
        };
      }
    }

    const lower = pageText.toLowerCase();
    const expiredSignals = [
      "no longer accepting applications",
      "position has been filled",
      "job is no longer available",
      "posting has expired",
      "job not found",
      "position is no longer",
      "this position has been closed",
      "page not found",
    ];
    const hit = expiredSignals.find((s) => lower.includes(s));
    if (hit) {
      return { checked: true, likely_expired: true, note: `Page text suggests expired: "${hit}"`, pageText };
    }
    return {
      checked: true,
      likely_expired: false,
      note: `HTTP ${status}, no expiry signals found (best effort check).`,
      pageText,
    };
  } catch (err) {
    return {
      checked: false,
      likely_expired: false,
      note: `Liveness check failed: ${err instanceof Error ? err.message : String(err)}`,
      pageText: null,
    };
  }
}

/** Second-chance fetch through Tavily's Extract API. Their crawler renders JS and gets
 * past most bot-walls that block a plain edge-runtime fetch, so this is worth one credit
 * before telling the user to paste the JD by hand. Shared verbatim (by design, not
 * import) with daily_loop — keep the two in sync. */
export async function tavilyExtract(apiKey: string, url: string): Promise<string | null> {
  try {
    const res = await fetch("https://api.tavily.com/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, urls: [url], extract_depth: "advanced" }),
    });
    if (!res.ok) return null;
    const payload = await res.json();
    const raw = payload?.results?.[0]?.raw_content;
    return typeof raw === "string" && raw.trim() ? raw : null;
  } catch {
    return null;
  }
}

const WALL_SIGNALS = [
  "additional verification required",
  "security check",
  "verify you are a human",
  "verify you're a human",
  "verifying you are human",
  "enable javascript and cookies",
  "just a moment",
  "request blocked",
  "access denied",
  "are you a robot",
  "captcha",
];

const JD_SIGNALS = [
  "responsibilities",
  "qualifications",
  "requirements",
  "what you'll do",
  "what you will do",
  "about the role",
  "about this role",
  "who you are",
  "we are looking for",
  "we're looking for",
  "years of experience",
  "equal opportunity",
];

/** Heuristic gate: does this text plausibly contain an actual job description, as opposed
 * to a bot-check page, a sign-in shell, or theme-config JSON? Only applied to URL-fetched
 * text — JD text the user pasted is always trusted. Shared verbatim with daily_loop. */
export function looksLikeJd(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  if (t.length < 500) return false;
  // A wall phrase on a short page is a wall; on a long page it may be footer noise.
  if (t.length < 4000 && WALL_SIGNALS.some((s) => t.includes(s))) return false;
  return JD_SIGNALS.some((s) => t.includes(s));
}

/** Workday postings serve a JS shell to plain fetches — stripHtml yields nothing, Tavily's
 * extractor usually fails too. But every myworkdayjobs.com posting URL maps onto the site's
 * own JSON endpoint (/wday/cxs/<tenant>/<site>/job/<path>), which returns
 * jobPostingInfo.jobDescription as HTML at plain HTTP 200 with no rendering and no
 * bot-wall. Shared verbatim with daily_loop. */
export async function fetchWorkdayJd(url: string): Promise<string | null> {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)myworkdayjobs\.com$/i.test(parsed.hostname)) return null;
    const segments = parsed.pathname.split("/").filter(Boolean);
    const jobIdx = segments.indexOf("job");
    if (jobIdx < 1 || jobIdx === segments.length - 1) return null;
    const tenant = parsed.hostname.split(".")[0];
    const site = segments[jobIdx - 1];
    const candidates = [
      // Full remaining path first; some tenants include a location segment before the slug.
      `${parsed.origin}/wday/cxs/${tenant}/${site}/${segments.slice(jobIdx).join("/")}`,
      `${parsed.origin}/wday/cxs/${tenant}/${site}/job/${segments[segments.length - 1]}`,
    ];
    for (const apiUrl of candidates) {
      const res = await fetch(apiUrl, { headers: { accept: "application/json" } });
      if (!res.ok) continue;
      const payload = await res.json().catch(() => null) as {
        jobPostingInfo?: { title?: string; location?: string; locationsText?: string; jobDescription?: string };
      } | null;
      const info = payload?.jobPostingInfo;
      if (typeof info?.jobDescription !== "string" || !info.jobDescription.trim()) continue;
      const headline = [info.title, info.locationsText ?? info.location].filter(Boolean).join(" — ");
      return stripHtml(`${headline ? `${headline}. ` : ""}${info.jobDescription}`).slice(0, 15000);
    }
    return null;
  } catch {
    return null;
  }
}

const VERDICT_TOOL = {
  name: "emit_verdict",
  description: "Emit the structured scorecard verdict for this job description.",
  input_schema: {
    type: "object",
    properties: {
      grade: {
        type: "string",
        enum: ["A+", "A", "B", "C", "D", "F"],
        description: "Letter grade for how good this role is for this candidate.",
      },
      company: {
        type: ["string", "null"],
        description:
          'The hiring company\'s name, as stated anywhere in the posting or clearly inferable from it (the header, "About us", product names, the posting URL). Null only if genuinely absent.',
      },
      title: {
        type: ["string", "null"],
        description: "The role title as the posting states it; null if genuinely absent.",
      },
      comp_min: { type: ["number", "null"] },
      comp_max: { type: ["number", "null"] },
      remote_type: { type: ["string", "null"] },
      location: {
        type: ["string", "null"],
        description:
          "The posting's stated location(s)/city, e.g. \"San Francisco, CA\" or \"San Francisco or New York (onsite)\" or \"Remote (US)\"; null if truly unspecified.",
      },
      pain_line: {
        type: ["string", "null"],
        description: "One sentence naming the real pain behind this requisition.",
      },
      gaps: { type: "array", items: { type: "string" } },
      reasoning: {
        type: "string",
        description:
          "Short paragraph walking through comp -> location -> contract -> blockers -> degree, in that order.",
      },
    },
    required: ["grade", "gaps", "reasoning"],
  },
};

/** Runs the actual scorecard call against the Claude API. Shared verbatim (by design, not
 * import — edge functions deploy as independent bundles) with daily_loop's inline scoring
 * loop, so keep the two in sync if this changes. */
export async function scoreJd(opts: {
  jdText: string;
  livenessNote: string | null;
  profile: Record<string, unknown>;
  model: string;
  apiKey: string;
}): Promise<VerdictResult> {
  // The model occasionally answers a forced tool_choice with an empty or near-empty input
  // ({} or just a grade). Before this guard those came out as fully-defaulted cards — a
  // bare "C" with no reasoning, no comp, no gaps — indistinguishable from a real verdict.
  // An unexplained grade is worse than no grade, so: retry once, then give up loudly.
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const verdict = await scoreJdOnce(opts);
      if (verdict.reasoning.trim()) return verdict;
      lastErr = new Error("Model returned an empty verdict (grade with no reasoning) — not scored.");
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastErr ?? new Error("Scoring failed.");
}

async function scoreJdOnce(opts: {
  jdText: string;
  livenessNote: string | null;
  profile: Record<string, unknown>;
  model: string;
  apiKey: string;
}): Promise<VerdictResult> {
  const { jdText, livenessNote, profile, model, apiKey } = opts;

  const systemPrompt = `You are screening a job description against a candidate's stored career record for Fieldwork, a job-search cockpit. The career record is the absolute ceiling: never claim anything for the candidate beyond what is in it, and never suggest claiming anything listed in "do not claim". Never mention anything listed in "never mention".

Candidate career record (markdown):
${String(profile.career_record ?? "(none on file)")}

Comp floor: ${profile.comp_floor ?? "(not set)"}
Target band strategy: ${profile.target_band_strategy ?? "(not set)"}
Remote preferences: ${profile.remote_prefs ?? "(not set)"}
Target titles: ${Array.isArray(profile.target_titles) ? (profile.target_titles as string[]).join(", ") : "(none set)"}
Avoid titles: ${Array.isArray(profile.avoid_titles) ? (profile.avoid_titles as string[]).join(", ") : "(none set)"}
Do not claim: ${Array.isArray(profile.do_not_claim) ? (profile.do_not_claim as string[]).join(", ") : "(none)"}
Never mention: ${Array.isArray(profile.never_mention) ? (profile.never_mention as string[]).join(", ") : "(none)"}

Evaluate the job description strictly in this order, per the resume-builder methodology:
1. Comp — does the posted range clear the comp floor and target band strategy? If the posting states no range, that is NOT a mark against the role: most employers (universities, hospitals, nonprofits, government) simply do not publish one. Do not guess a number, do not assume it is low, and do not grade down for the absence. Grade the role on the criteria below and record the missing range as a gap. Comp only pulls a grade DOWN when a range is actually stated and it falls short.
2. Location / remote fit — does it match remote preferences?
3. Contract type — full-time vs. contract/temp, and any red flags there.
4. Blockers — anything that conflicts with do-not-claim / never-mention, or an obvious dealbreaker.
5. Degree / education requirements the candidate may not meet.

Extract comp_min/comp_max (numbers, annual USD, null if not determinable), remote_type (the working arrangement — e.g. "remote", "hybrid", "onsite"; null if unclear), and location (the specific place the posting states — the city or cities, e.g. "San Francisco, CA" or "San Francisco or New York (onsite)" or "Remote (US)"; null if truly unspecified) from the JD text itself. remote_type is the arrangement; location is the actual where — fill both.

Also extract company (the hiring company's name) and title (the role title). The company name is almost always somewhere in the posting — the header, the "About us" paragraph, product names, or the URL — so look hard before returning null; a card labelled "(unknown)" costs the user a manual fix later.

Grade the role on this scale. You are grading the ROLE as an opportunity for this candidate — not grading the candidate, and not grading the quality of the job posting's writing:
- "A+" — matches a target title, matches remote preferences, no blockers, and a stated range that clears the floor. Rare. Reserve it: if you are talking yourself into it, it is an A.
- "A" — strong fit, apply now. Title and location work; any gaps are minor. A role matching a target title with no stated comp and no blockers belongs here or at B, never lower.
- "B" — worth applying, with real caveats (a stated range that lands slightly under, a gap worth naming, a title adjacent to target).
- "C" — a stretch. Would need something to break right: a stated range under the floor, a title on the avoid list, or a gap that needs explaining away.
- "D" — weak. A stated range clearly under the floor, badly misaligned on location or contract type, or several substantive gaps at once. Applying is a long shot.
- "F" — skip. A hard blocker: conflicts with do-not-claim, a dealbreaker requirement, or a stated range so far under the floor it is not worth the hour.

Grade honestly, and grade on evidence in the posting — never on what it fails to mention. Missing information is a gap to name, not a reason to mark down; the only facts that lower a grade are ones the posting actually states. An inflated grade costs the candidate a wasted application; a deflated one costs a real opportunity, which is the worse error here because the candidate never sees the role again. The distribution should look like a real job board — most roles land at B or C, and D/F are for postings with something concretely wrong, not merely unstated.

List concrete gaps as short strings. Write one pain_line naming the real pain behind this requisition, if inferable. Call the emit_verdict tool with your result — do not respond in plain text.`;

  const userMessage = livenessNote
    ? `Liveness check note: ${livenessNote}\n\nJob description:\n${jdText}`
    : `Job description:\n${jdText}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      // 1500 used to truncate long verdicts mid-emission, leaving grade-only cards with
      // empty reasoning. Headroom plus the stop_reason check below prevents that.
      max_tokens: 3000,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      tools: [VERDICT_TOOL],
      tool_choice: { type: "tool", name: "emit_verdict" },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Claude API error (${res.status}): ${detail.slice(0, 500)}`);
  }

  const payload = await res.json();
  if (payload.stop_reason === "max_tokens") {
    throw new Error("Verdict ran out of tokens mid-emission — not scored. Re-run this candidate.");
  }
  const toolUse = (payload.content ?? []).find((b: { type: string }) => b.type === "tool_use");
  if (!toolUse) {
    throw new Error("Claude did not return a structured verdict.");
  }
  const input = toolUse.input as Partial<VerdictResult>;
  return {
    // No grade emitted means the call did not really score it — "C" (a stretch, look
    // closer) is the honest default. Never fall back to a grade that reads as a
    // recommendation the model did not make.
    grade: input.grade ?? "C",
    company: input.company ?? null,
    title: input.title ?? null,
    comp_min: input.comp_min ?? null,
    comp_max: input.comp_max ?? null,
    remote_type: input.remote_type ?? null,
    location: input.location ?? null,
    pain_line: input.pain_line ?? null,
    gaps: Array.isArray(input.gaps) ? input.gaps : [],
    reasoning: input.reasoning ?? "",
  };
}

/** Logs one intake run to fw_intake_runs, plus a row per role to fw_intake_run_items.
 *
 * Two things are otherwise lost the moment the browser tab closes. The counts: only roles
 * the user files or discards reach fw_applications, so the funnel has no denominator. And
 * the cards themselves: a scored card lives only in the HTTP response, so a failed render
 * burns the Claude call and the result is unrecoverable. Both tables exist so a run can be
 * reopened and filed later, and a surprising grade can be read rather than guessed at.
 *
 * Deliberately best-effort: a logging failure must never fail the user's actual scorecard,
 * so everything here is caught and swallowed. */
export interface RunLogClient {
  // Method syntax on purpose: it types bivariantly, so the real SupabaseClient satisfies
  // this without importing its generics (which differ across supabase-js versions).
  from(table: string): {
    insert(values: Record<string, unknown> | Record<string, unknown>[]): PromiseLike<unknown> & {
      select(cols?: string): PromiseLike<{ data: unknown; error: unknown }>;
    };
  };
}

/** Maps one result row (whatever shape it came back as) onto an fw_intake_run_items row. */
export function toRunItem(runId: string, r: Record<string, unknown>): Record<string, unknown> {
  const outcome = r.duplicate
    ? "duplicate"
    : r.expired
      ? "expired"
      : r.error
        ? "error"
        : "graded";
  return {
    run_id: runId,
    company: r.company ?? "(unknown)",
    title: r.title ?? null,
    url: r.url ?? null,
    outcome,
    grade: outcome === "graded" ? (r.grade ?? null) : null,
    comp_min: r.comp_min ?? null,
    comp_max: r.comp_max ?? null,
    remote_type: r.remote_type ?? null,
    location: r.location ?? null,
    pain_line: r.pain_line ?? null,
    gaps: Array.isArray(r.gaps) ? r.gaps : [],
    reasoning: r.reasoning ?? null,
    jd_text: r.jd_text ?? null,
    live_checked_at: r.live_checked_at ?? null,
    liveness_note: r.liveness_note ?? null,
    error: r.error ?? null,
  };
}

export async function logRun(
  supabase: RunLogClient,
  row: Record<string, unknown>,
  items: Record<string, unknown>[] = [],
): Promise<void> {
  try {
    const { data, error } = await supabase
      .from("fw_intake_runs")
      .insert(row)
      .select("id");
    if (error) return;
    const runId = (data as { id: string }[] | null)?.[0]?.id;
    if (!runId || items.length === 0) return;
    await supabase
      .from("fw_intake_run_items")
      .insert(items.map((r) => toRunItem(runId, r)));
  } catch (_err) {
    // Intentionally ignored — telemetry is never worth failing a real request over.
  }
}

/** Reads models map from fw_settings, applying the scorecard -> default -> hardcoded
 * fallback chain described in the file header. */
export function resolveModel(settings: Record<string, unknown>, action: string): string {
  const models = (settings.models ?? {}) as Record<string, string>;
  return models[action] ?? models.default ?? "claude-sonnet-5";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({
          error:
            "Missing Supabase secret ANTHROPIC_API_KEY. Set it with `supabase secrets set ANTHROPIC_API_KEY=sk-ant-...` (or via the dashboard's Edge Function secrets panel), then retry.",
        }),
        { status: 500, headers: { ...CORS_HEADERS, "content-type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const body = await req.json().catch(() => ({}));
    // company/title are not used for scoring. If the user typed them they win; otherwise
    // the model's own extraction (see VERDICT_TOOL) fills them, so the logged run item is
    // a complete, re-filable card rather than one labelled "(unknown)".
    const { jd_text, url, company, title } = body as {
      jd_text?: string;
      url?: string;
      company?: string;
      title?: string;
    };

    if (!jd_text && !url) {
      return new Response(JSON.stringify({ error: "Provide jd_text or url." }), {
        status: 400,
        headers: { ...CORS_HEADERS, "content-type": "application/json" },
      });
    }

    const [{ data: profile }, { data: settingsRows }] = await Promise.all([
      supabase.from("fw_profile").select("*").limit(1).maybeSingle(),
      supabase.from("fw_settings").select("key, value"),
    ]);

    const settings: Record<string, unknown> = {};
    for (const row of (settingsRows ?? []) as { key: string; value: unknown }[]) {
      settings[row.key] = row.value;
    }
    const model = resolveModel(settings, "scorecard");

    let livenessNote: string | null = null;
    let liveCheckedAt: string | null = null;
    let effectiveJdText = jd_text ?? "";

    if (url) {
      const liveness = await checkLiveness(url);
      livenessNote = liveness.note;
      liveCheckedAt = new Date().toISOString();
      if (!effectiveJdText && liveness.pageText) {
        effectiveJdText = liveness.pageText;
      }
    }

    // Workday-specific rescue before spending a Tavily credit: the CXS JSON endpoint
    // serves the real JD where both the plain fetch and Tavily's extractor get a shell.
    if (!jd_text && url && !looksLikeJd(effectiveJdText)) {
      const wd = await fetchWorkdayJd(url);
      if (wd && (looksLikeJd(wd) || !effectiveJdText)) effectiveJdText = wd;
    }

    // URL-derived text only — pasted JD text is trusted as-is. If the direct fetch got a
    // bot-wall or shell, try Tavily's extractor before giving up.
    if (!jd_text && url && !looksLikeJd(effectiveJdText)) {
      const tavilyKey = Deno.env.get("TAVILY_API_KEY");
      if (tavilyKey) {
        const extracted = await tavilyExtract(tavilyKey, url);
        if (extracted) {
          const cleaned = stripHtml(extracted).slice(0, 15000);
          if (looksLikeJd(cleaned) || !effectiveJdText) effectiveJdText = cleaned;
        }
      }
    }

    if (!effectiveJdText) {
      return new Response(
        JSON.stringify({
          error: "Could not obtain job description text from that URL — paste the JD text directly instead.",
        }),
        { status: 400, headers: { ...CORS_HEADERS, "content-type": "application/json" } }
      );
    }

    // Grading a bot-check page fabricates an F/D card out of zero substance. Refuse
    // honestly instead, before spending the Claude call.
    if (!jd_text && !looksLikeJd(effectiveJdText)) {
      return new Response(
        JSON.stringify({
          error:
            "That URL served a bot-check or empty shell instead of the posting — open it in a browser and paste the JD text directly instead.",
        }),
        { status: 400, headers: { ...CORS_HEADERS, "content-type": "application/json" } }
      );
    }

    const scored = await scoreJd({
      jdText: effectiveJdText,
      livenessNote,
      profile: (profile ?? {}) as Record<string, unknown>,
      model,
      apiKey,
    });

    await logRun(
      supabase,
      {
        kind: "scorecard",
        candidates: 1,
        scored: 1,
        grades: { [scored.grade]: 1 },
        model,
      },
      [
        {
          ...scored,
          // What the user typed wins; the model's extraction fills the blanks.
          company: company ?? scored.company ?? "(unknown)",
          title: title ?? scored.title ?? null,
          url: url ?? null,
          jd_text: effectiveJdText,
          live_checked_at: liveCheckedAt,
          liveness_note: livenessNote,
        },
      ],
    );

    return new Response(
      JSON.stringify({
        ...scored,
        // User-typed values win over extraction here too, so the response card always
        // matches what the run item logged.
        company: company ?? scored.company ?? null,
        title: title ?? scored.title ?? null,
        jd_text: effectiveJdText,
        live_checked_at: liveCheckedAt,
        liveness_note: livenessNote,
      }),
      { headers: { ...CORS_HEADERS, "content-type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error in scorecard." }),
      { status: 500, headers: { ...CORS_HEADERS, "content-type": "application/json" } }
    );
  }
});
