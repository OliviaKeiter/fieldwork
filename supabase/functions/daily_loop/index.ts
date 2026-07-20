// Supabase Edge Function: daily_loop
//
// Two modes:
//   1. POST { candidates: [{ company, title, jd_text?, url? }, ...] } — score a
//      client-supplied list (the original Phase 2 paste mode).
//   2. POST { source: true, count?: number } — autonomous sourcing (SPEC.md open question
//      #2, resolved 2026-07-13: Tavily). Searches the web for live roles matching
//      fw_profile.target_titles, extracts distinct postings via a Claude triage call,
//      dedupes, and scores each like mode 1. Requires the TAVILY_API_KEY Supabase secret
//      (free tier at tavily.com); returns a clear error naming the secret if unset.
//      Searches are steered toward ATS hosts and away from bot-walled aggregators
//      (Indeed/LinkedIn/Ladders serve checkpoints or shells to server-side fetches), and
//      fetched text must pass a looksLikeJd gate — with a Tavily Extract second chance —
//      before it's scored, so walls surface as error rows instead of junk F/D cards.
// Both modes dedupe against fw_applications (company-variant+title keys, see matchKeys,
// plus canonical posting URL against fw_jds) and for every non-duplicate run the same
// inline scorecard logic as the `scorecard` function (liveness check if a url is known,
// then a Claude verdict call). Sourcing mode additionally filters search hits whose URL is
// already known (filed, or graded within the last 14 days and still pending review) BEFORE
// the triage call, so candidate slots go to genuinely new roles instead of re-discovering
// the same postings run after run.
//
// IMPORTANT — this function does NOT write to fw_applications / fw_jds. SPEC.md §5 says
// daily-loop results should "stack up for review", and the Intake screen spec (§9 gate,
// and the task brief for this build) is explicit that verdict cards must be reviewed
// before filing, not auto-filed. So this returns the scored, deduped results; the Intake UI
// renders them as the same verdict cards used for a single scorecard run, each with its own
// [File as to_apply] / [Discard] — filing happens one click at a time, same as scorecard.
//
// Model + secret handling mirror `scorecard` exactly: fw_settings.models.daily_loop falls
// back to models.default, falls back to 'claude-sonnet-5'; ANTHROPIC_API_KEY must be a
// Supabase secret, never hardcoded.

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Grade = "A+" | "A" | "B" | "C" | "D" | "F";

interface VerdictResult {
  grade: Grade;
  comp_min: number | null;
  comp_max: number | null;
  remote_type: string | null;
  location: string | null;
  pain_line: string | null;
  gaps: string[];
  reasoning: string;
}

interface Candidate {
  company: string;
  title?: string | null;
  jd_text?: string | null;
  url?: string | null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface JobPostingMeta {
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
 * this is the only honest expiry signal there is. Without it, sourcing runs happily return
 * months-dead roles that read as live. */
function extractJobPostingMeta(rawBody: string): JobPostingMeta | null {
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

interface LivenessResult {
  checked: boolean;
  likely_expired: boolean;
  /** True only for evidence we'd stake a skip on: a real 404/410, or a machine-readable
   * `validThrough` already in the past. The page-copy phrase match sets likely_expired but
   * NOT this — those phrases can appear in unrelated page furniture, and a false positive
   * there would silently drop a live role. Definitive signals skip; fuzzy ones just inform
   * the model. */
  definite_expired: boolean;
  note: string;
  pageText: string | null;
}

async function checkLiveness(url: string): Promise<LivenessResult> {
  try {
    const res = await fetch(url, { redirect: "follow" });
    const status = res.status;
    const rawBody = await res.text();
    const pageText = stripHtml(rawBody).slice(0, 15000);
    if (status === 404 || status === 410) {
      return {
        checked: true,
        likely_expired: true,
        definite_expired: true,
        note: `HTTP ${status} — posting removed.`,
        pageText,
      };
    }

    const meta = extractJobPostingMeta(rawBody);
    if (meta?.validThrough) {
      const expiry = new Date(meta.validThrough);
      if (!Number.isNaN(expiry.getTime()) && expiry.getTime() < Date.now()) {
        return {
          checked: true,
          likely_expired: true,
          definite_expired: true,
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
      return {
        checked: true,
        likely_expired: true,
        definite_expired: false,
        note: `Page text suggests expired: "${hit}"`,
        pageText,
      };
    }
    return {
      checked: true,
      likely_expired: false,
      definite_expired: false,
      note: `HTTP ${status}, no expiry signals found${
        meta?.validThrough ? `; validThrough ${meta.validThrough.slice(0, 10)}` : ""
      } (best effort check).`,
      pageText,
    };
  } catch (err) {
    return {
      checked: false,
      likely_expired: false,
      definite_expired: false,
      note: `Liveness check failed: ${err instanceof Error ? err.message : String(err)}`,
      pageText: null,
    };
  }
}

/** Workday postings serve a JS shell to plain fetches — stripHtml yields nothing, Tavily's
 * extractor usually fails too, and the candidate dies as an error row. But every
 * myworkdayjobs.com posting URL maps onto the site's own JSON endpoint
 * (/wday/cxs/<tenant>/<site>/job/<path>), which returns jobPostingInfo.jobDescription as
 * HTML at plain HTTP 200 with no rendering and no bot-wall. Sourcing steers toward Workday
 * (it's in ATS_HOSTS), so this is the difference between scoring those roles and losing
 * every one of them. */
async function fetchWorkdayJd(url: string): Promise<string | null> {
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

/** The model occasionally answers a forced tool_choice with an empty or near-empty input
 * ({} or just a grade). Before this guard those came out as fully-defaulted cards — a bare
 * "C" with no reasoning, no comp, no gaps — indistinguishable from a real verdict in the
 * review queue. An unexplained grade is worse than no grade, so: retry once, then give up
 * loudly (the caller turns the throw into an error row). */
async function scoreJd(opts: {
  jdText: string;
  livenessNote: string | null;
  profile: Record<string, unknown>;
  model: string;
  apiKey: string;
}): Promise<VerdictResult> {
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
      // 1500 used to truncate long verdicts mid-emission: the tool input arrived with the
      // early fields (grade first) but empty gaps/reasoning, and the defective card sailed
      // into the review queue as an unexplained grade. Headroom plus the stop_reason check
      // below turns that failure mode into an honest error row.
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
interface RunLogClient {
  // Method syntax on purpose: it types bivariantly, so the real SupabaseClient satisfies
  // this without importing its generics (which differ across supabase-js versions).
  from(table: string): {
    insert(values: Record<string, unknown> | Record<string, unknown>[]): PromiseLike<unknown> & {
      select(cols?: string): PromiseLike<{ data: unknown; error: unknown }>;
    };
  };
}

/** Maps one result row (whatever shape it came back as) onto an fw_intake_run_items row. */
function toRunItem(runId: string, r: Record<string, unknown>): Record<string, unknown> {
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

async function logRun(
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

function resolveModel(settings: Record<string, unknown>, action: string): string {
  const models = (settings.models ?? {}) as Record<string, string>;
  return models[action] ?? models.default ?? "claude-sonnet-5";
}

function normToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** All keys under which a company+title pair counts as "the same role" — mirrored verbatim
 * in the app's intake.ts. The scoring model extracts the company name slightly differently
 * run to run ("Precision AQ", "PrecisionAQ / Precision Medicine Group", "Precision AQ
 * (Precision Medicine Group)"), and an exact string match waves every variant through as a
 * "new" role. So alongside the full normalized name, each slash/paren-delimited segment
 * gets its own key. Titles still match exactly (normalized). Deliberately NOT split on
 * hyphens or commas: "Coca-Cola" and "G-P" are one name, not two. */
function matchKeys(company: string, title: string | null | undefined): string[] {
  const t = normToken(title ?? "");
  const names = new Set<string>();
  const full = normToken(company);
  if (full) names.add(full);
  for (const part of company.split(/[/()|]/)) {
    const p = normToken(part);
    if (p) names.add(p);
  }
  return [...names].map((n) => `${n}::${t}`);
}

/** Canonical form of a posting URL for dedupe: host + path, no protocol/www/query/hash.
 * The same Greenhouse rec arrives as http and https, with and without tracking params —
 * all of those are one role. Mirrored verbatim in the app's intake.ts. */
function normalizeJobUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const parsed = new URL(u);
    return (parsed.host.replace(/^www\./, "") + parsed.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch {
    return null;
  }
}

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  raw_content?: string | null;
}

/** Aggregators that serve bot-walls or empty shells to server-side fetches (Indeed's 403
 * checkpoint, LinkedIn's sign-in shell, Ladders' scraped stubs). A search hit on these
 * domains almost never yields scoreable JD text, so they're excluded at the search layer
 * rather than wasting triage + scoring calls discovering it per-run. */
const AGGREGATOR_BLOCKLIST = [
  "indeed.com",
  "linkedin.com",
  "theladders.com",
  "glassdoor.com",
  "ziprecruiter.com",
  "bebee.com",
  "lensa.com",
  "jobrapido.com",
  "simplyhired.com",
  "salary.com",
  "talent.com",
  "jooble.org",
  "adzuna.com",
];

/** ATS hosts that serve real JD text at HTTP 200 to plain fetches — where a sourcing run
 * actually wants to land. */
const ATS_HOSTS = [
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "jobs.lever.co",
  "jobs.ashbyhq.com",
  "apply.workable.com",
  "jobs.smartrecruiters.com",
  "myworkdayjobs.com",
  "icims.com",
  "jobs.jobvite.com",
  "recruitee.com",
  "bamboohr.com",
];

async function tavilySearch(
  apiKey: string,
  query: string,
  domains?: { include?: string[]; exclude?: string[] },
): Promise<TavilyResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: 10,
      include_raw_content: true,
      days: 30,
      ...(domains?.include ? { include_domains: domains.include } : {}),
      ...(domains?.exclude ? { exclude_domains: domains.exclude } : {}),
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Tavily API error (${res.status}): ${detail.slice(0, 300)}`);
  }
  const payload = await res.json();
  return Array.isArray(payload.results) ? (payload.results as TavilyResult[]) : [];
}

/** Second-chance fetch through Tavily's Extract API. Their crawler renders JS and gets
 * past most bot-walls that block a plain edge-runtime fetch, so this is worth one credit
 * before writing a candidate off as unfetchable. */
async function tavilyExtract(apiKey: string, url: string): Promise<string | null> {
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
 * to a bot-check page, a sign-in shell, or theme-config JSON? Scoring a wall page burns a
 * Claude call and produces a junk F/D card that clutters the review queue — an honest
 * "couldn't fetch" error row is strictly better, so anything failing this gate goes down
 * that path instead. Deliberately loose: user-pasted JD text never passes through here. */
function looksLikeJd(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  if (t.length < 500) return false;
  // A wall phrase on a short page is a wall; on a long page it may be footer noise.
  if (t.length < 4000 && WALL_SIGNALS.some((s) => t.includes(s))) return false;
  return JD_SIGNALS.some((s) => t.includes(s));
}

const CANDIDATES_TOOL = {
  name: "emit_candidates",
  description: "Emit the distinct, real job postings found in these search results.",
  input_schema: {
    type: "object",
    properties: {
      candidates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            company: { type: "string" },
            title: { type: "string" },
            url: { type: "string" },
          },
          required: ["company", "title", "url"],
        },
      },
    },
    required: ["candidates"],
  },
};

/** One Claude triage call: search results in, distinct real postings out. Filters list
 * pages, staffing-agency reposts, and obviously-dead links before the expensive per-role
 * scoring pass. */
async function extractCandidates(opts: {
  results: TavilyResult[];
  profile: Record<string, unknown>;
  model: string;
  apiKey: string;
  count: number;
}): Promise<Candidate[]> {
  const { results, profile, model, apiKey, count } = opts;
  const compact = results.map((r) => ({
    title: r.title,
    url: r.url,
    snippet: (r.content ?? "").slice(0, 600),
  }));

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2500,
      system: `You triage web-search results for a job-search app. From the results below, extract up to ${count} DISTINCT real, individual job postings (one specific role at one specific company, on a page where someone could apply). Exclude: job-board list/search pages, staffing-agency reposts, articles, duplicate postings of the same role, and anything that looks expired. Prefer roles whose titles match the candidate's target titles and avoid their avoid-titles.

Strongly prefer URLs on the employer's own careers site or an ATS host (greenhouse.io, lever.co, ashbyhq.com, workable.com, smartrecruiters.com, myworkdayjobs.com, icims.com, and the like) over job-board aggregators (Indeed, LinkedIn, Ladders, ZipRecruiter, Glassdoor) — aggregator pages usually block automated fetches, so their candidates die downstream. If the same role appears on both, emit the employer/ATS URL.

Target titles: ${Array.isArray(profile.target_titles) ? (profile.target_titles as string[]).join(", ") : "(none set)"}
Avoid titles: ${Array.isArray(profile.avoid_titles) ? (profile.avoid_titles as string[]).join(", ") : "(none set)"}

Call emit_candidates with your result — do not respond in plain text.`,
      messages: [{ role: "user", content: JSON.stringify(compact) }],
      tools: [CANDIDATES_TOOL],
      tool_choice: { type: "tool", name: "emit_candidates" },
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Claude API error during candidate triage (${res.status}): ${detail.slice(0, 300)}`);
  }
  const payload = await res.json();
  const toolUse = (payload.content ?? []).find((b: { type: string }) => b.type === "tool_use");
  if (!toolUse) return [];
  const raw = (toolUse.input as { candidates?: { company?: string; title?: string; url?: string }[] }).candidates ?? [];
  // Carry Tavily's raw page content along as jd_text seed so scoring can proceed even when
  // the posting page blocks direct fetches from the edge runtime.
  const byUrl = new Map(results.map((r) => [r.url, r.raw_content ?? null]));
  return raw
    .filter((c) => c.company && c.title && c.url)
    .map((c) => ({
      company: c.company!,
      title: c.title!,
      url: c.url!,
      jd_text: byUrl.get(c.url!) ?? null,
    }));
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
    const { candidates: suppliedCandidates, source, count } = body as {
      candidates?: Candidate[];
      source?: boolean;
      count?: number;
    };
    let candidates = suppliedCandidates ?? [];

    if (!source && (!Array.isArray(candidates) || candidates.length === 0)) {
      return new Response(
        JSON.stringify({ error: "Provide a non-empty candidates array, or { source: true } to search the web." }),
        { status: 400, headers: { ...CORS_HEADERS, "content-type": "application/json" } }
      );
    }

    const [{ data: profile }, { data: settingsRows }, { data: existingApps }, { data: existingJds }, { data: recentItems }] =
      await Promise.all([
        supabase.from("fw_profile").select("*").limit(1).maybeSingle(),
        supabase.from("fw_settings").select("key, value"),
        supabase.from("fw_applications").select("company, title"),
        supabase.from("fw_jds").select("url"),
        // Graded-and-still-pending cards from recent runs: their URLs shouldn't consume
        // sourcing slots again while the user hasn't dealt with the existing card yet.
        supabase
          .from("fw_intake_run_items")
          .select("url")
          .eq("outcome", "graded")
          .gte("created_at", new Date(Date.now() - 14 * 86400000).toISOString()),
      ]);

    const existingKeys = new Set<string>();
    for (const a of (existingApps ?? []) as { company: string; title: string | null }[]) {
      for (const k of matchKeys(a.company, a.title)) existingKeys.add(k);
    }
    const existingUrls = new Set<string>();
    for (const j of (existingJds ?? []) as { url: string | null }[]) {
      const u = normalizeJobUrl(j.url);
      if (u) existingUrls.add(u);
    }
    const recentGradedUrls = new Set<string>();
    for (const item of (recentItems ?? []) as { url: string | null }[]) {
      const u = normalizeJobUrl(item.url);
      if (u) recentGradedUrls.add(u);
    }

    const settings: Record<string, unknown> = {};
    for (const row of (settingsRows ?? []) as { key: string; value: unknown }[]) {
      settings[row.key] = row.value;
    }
    const model = resolveModel(settings, "daily_loop");

    // Read outside the sourcing branch: the extract-fallback in the scoring loop uses it
    // for paste-mode URL candidates too, when the secret happens to be set.
    const tavilyKey = Deno.env.get("TAVILY_API_KEY") ?? null;
    let searchedQueries: string[] = [];
    if (source && candidates.length === 0) {
      if (!tavilyKey) {
        return new Response(
          JSON.stringify({
            error:
              "Missing Supabase secret TAVILY_API_KEY. Create a free key at tavily.com, then set it with `supabase secrets set TAVILY_API_KEY=tvly-...` (or via the dashboard's Edge Function secrets panel) and retry. Until then, use the paste-candidates mode.",
          }),
          { status: 500, headers: { ...CORS_HEADERS, "content-type": "application/json" } }
        );
      }

      const targetTitles = Array.isArray((profile ?? {}).target_titles)
        ? ((profile as Record<string, unknown>).target_titles as string[])
        : [];
      if (targetTitles.length === 0) {
        return new Response(
          JSON.stringify({ error: "No target titles set in the profile — add them in Settings before sourcing." }),
          { status: 400, headers: { ...CORS_HEADERS, "content-type": "application/json" } }
        );
      }

      const wanted = Math.min(Math.max(count ?? 10, 1), 20);
      // Search a rotating slice of target titles, two queries each: one across ATS hosts
      // (where server-side fetches actually get JD text) and one open-web query with the
      // bot-walled aggregators excluded. 8 queries per run ≈ 125 runs/month on the free
      // tier's 1000 searches — still comfortable for a few runs a day.
      const offset = Math.floor(Date.now() / 86400000) % targetTitles.length;
      const titlesToSearch = Array.from(
        { length: Math.min(4, targetTitles.length) },
        (_, i) => targetTitles[(offset + i) % targetTitles.length]
      );
      const queries = titlesToSearch.flatMap((t) => [
        { q: `"${t}" remote job opening apply`, domains: { exclude: AGGREGATOR_BLOCKLIST } },
        { q: `${t} remote apply`, domains: { include: ATS_HOSTS } },
      ]);
      searchedQueries = queries.map(({ q, domains }) => (domains.include ? `[ats] ${q}` : q));

      const searchBatches = await Promise.all(
        queries.map(({ q, domains }) =>
          tavilySearch(tavilyKey, q, domains).catch(() => [] as TavilyResult[])
        )
      );
      const seenUrls = new Set<string>();
      const merged: TavilyResult[] = [];
      for (const batch of searchBatches) {
        for (const r of batch) {
          if (!r.url || seenUrls.has(r.url)) continue;
          seenUrls.add(r.url);
          merged.push(r);
        }
      }
      // Drop hits whose URL is already in the pipeline (fw_jds) or already graded and
      // pending review, BEFORE triage. Without this, known roles eat candidate slots —
      // one weekend run spent 6 of 15 slots re-discovering roles the user had already
      // seen — and the fresh tail of the search results never gets triaged at all.
      const fresh = merged.filter((r) => {
        const u = normalizeJobUrl(r.url);
        return u === null || (!existingUrls.has(u) && !recentGradedUrls.has(u));
      });

      if (fresh.length === 0) {
        await logRun(supabase, {
          kind: "daily_loop_source",
          requested: wanted,
          searched_queries: searchedQueries,
          candidates: 0,
          model,
        }, []);
        return new Response(JSON.stringify({ results: [], sourced: 0, searched_queries: searchedQueries }), {
          headers: { ...CORS_HEADERS, "content-type": "application/json" },
        });
      }

      candidates = await extractCandidates({
        results: fresh,
        profile: (profile ?? {}) as Record<string, unknown>,
        model,
        apiKey,
        count: wanted,
      });
    }

    const results = await Promise.all(
      candidates.map(async (c) => {
        const urlKey = normalizeJobUrl(c.url);
        if (
          matchKeys(c.company ?? "", c.title).some((k) => existingKeys.has(k)) ||
          (urlKey !== null && existingUrls.has(urlKey))
        ) {
          return { company: c.company, title: c.title ?? null, url: c.url ?? null, duplicate: true };
        }

        // JD text typed/pasted by the user is trusted as-is; anything that came from a
        // fetch (Tavily raw content, the liveness page text) has to pass the looksLikeJd
        // gate before it's worth a scoring call.
        const userSuppliedJd = !source && !!c.jd_text;

        let livenessNote: string | null = null;
        let liveCheckedAt: string | null = null;
        let effectiveJdText = c.jd_text ?? "";

        if (c.url) {
          const liveness = await checkLiveness(c.url);
          livenessNote = liveness.note;
          liveCheckedAt = new Date().toISOString();
          if (!effectiveJdText && liveness.pageText) effectiveJdText = liveness.pageText;
          // Tavily's raw content is sometimes a shell where the direct fetch got the real
          // page — prefer whichever actually reads like a JD.
          else if (
            !userSuppliedJd &&
            !looksLikeJd(effectiveJdText) &&
            looksLikeJd(liveness.pageText)
          ) {
            effectiveJdText = liveness.pageText!;
          }

          // A posting we can prove is dead isn't worth a Claude call or a card. Job boards
          // keep serving expired listings at HTTP 200, so without this a sourcing run fills
          // up with months-old roles that read as live.
          if (liveness.definite_expired) {
            return {
              company: c.company,
              title: c.title ?? null,
              url: c.url ?? null,
              duplicate: false,
              expired: true,
              live_checked_at: liveCheckedAt,
              liveness_note: livenessNote,
            };
          }
        }

        // Workday-specific rescue before spending a Tavily credit: the CXS JSON endpoint
        // serves the real JD where both the plain fetch and Tavily's extractor get a shell.
        if (!userSuppliedJd && !looksLikeJd(effectiveJdText) && c.url) {
          const wd = await fetchWorkdayJd(c.url);
          if (wd && (looksLikeJd(wd) || !effectiveJdText)) effectiveJdText = wd;
        }

        // Second-chance fetch: a plain edge-runtime fetch gets bot-walled by many career
        // sites; Tavily's extractor renders JS and usually gets through. One credit is
        // cheaper than a junk card.
        if (!userSuppliedJd && !looksLikeJd(effectiveJdText) && c.url && tavilyKey) {
          const extracted = await tavilyExtract(tavilyKey, c.url);
          if (extracted) {
            const cleaned = stripHtml(extracted).slice(0, 15000);
            if (looksLikeJd(cleaned) || !effectiveJdText) effectiveJdText = cleaned;
          }
        }

        if (!effectiveJdText) {
          return {
            company: c.company,
            title: c.title ?? null,
            url: c.url ?? null,
            duplicate: false,
            live_checked_at: liveCheckedAt,
            liveness_note: livenessNote,
            error: "No JD text on file or fetchable from the URL — provide jd_text for this candidate.",
          };
        }

        // Fetched text that still reads as a bot-check page or content-free shell: an
        // honest error row beats a fabricated F/D card. Error rows don't enter the review
        // queue, so walls stop cluttering it.
        if (!userSuppliedJd && !looksLikeJd(effectiveJdText)) {
          return {
            company: c.company,
            title: c.title ?? null,
            url: c.url ?? null,
            duplicate: false,
            live_checked_at: liveCheckedAt,
            liveness_note: livenessNote,
            error:
              "Couldn't retrieve the job description — the page served a bot-check or empty shell instead of the posting. Open the URL in a browser and paste the JD into a scorecard run.",
          };
        }

        try {
          const scored = await scoreJd({
            jdText: effectiveJdText,
            livenessNote,
            profile: (profile ?? {}) as Record<string, unknown>,
            model,
            apiKey,
          });
          return {
            company: c.company,
            title: c.title ?? null,
            url: c.url ?? null,
            jd_text: effectiveJdText,
            duplicate: false,
            live_checked_at: liveCheckedAt,
            liveness_note: livenessNote,
            ...scored,
          };
        } catch (err) {
          return {
            company: c.company,
            title: c.title ?? null,
            url: c.url ?? null,
            duplicate: false,
            error: err instanceof Error ? err.message : "Scoring failed for this candidate.",
          };
        }
      })
    );

    const grades: Record<string, number> = {};
    let duplicates = 0, expired = 0, errors = 0, scored = 0;
    for (const r of results as Record<string, unknown>[]) {
      if (r.duplicate) duplicates++;
      else if (r.expired) expired++;
      else if (r.error) errors++;
      else if (typeof r.grade === "string") {
        scored++;
        grades[r.grade] = (grades[r.grade] ?? 0) + 1;
      }
    }
    await logRun(
      supabase,
      {
        kind: source ? "daily_loop_source" : "daily_loop_paste",
        requested: source ? Math.min(Math.max(count ?? 10, 1), 20) : null,
        searched_queries: searchedQueries,
        candidates: candidates.length,
        duplicates,
        expired,
        errors,
        scored,
        grades,
        model,
      },
      results as Record<string, unknown>[],
    );

    return new Response(
      JSON.stringify({
        results,
        ...(source ? { sourced: candidates.length, searched_queries: searchedQueries } : {}),
      }),
      { headers: { ...CORS_HEADERS, "content-type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error in daily_loop." }),
      { status: 500, headers: { ...CORS_HEADERS, "content-type": "application/json" } }
    );
  }
});
