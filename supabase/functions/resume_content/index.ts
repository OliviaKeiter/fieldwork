// Supabase Edge Function: resume_content
//
// Phase 3 "Studio" (SPEC.md §6, §9 gate). Given an application_id, reads fw_profile (the
// ceiling — SPEC.md principle #1: nothing generated may exceed the career record) plus the
// target application's fw_applications row, its most recent fw_jds row, and any fw_lessons
// tied to that application, and calls Claude to produce structured resume content: a
// contact block, a tailored summary, experience bullets adapted from the career record, and
// a skills list — tuned to the target JD's pain_line/gaps but never inventing anything not
// already present in career_record. The client renders this JSON into a .docx (via docx.js)
// and a print-friendly HTML view; this function never touches Word/PDF generation itself.
//
// Ceiling enforcement is prompt-level (system prompt below states the rule in absolute
// terms, backed by a tool schema that only accepts strings — no numeric claims can be
// injected outside prose) plus a UI-level backstop: the Resume tab always shows the
// generated content in an editable review form with the same "ceiling" banner used in
// Settings, so a human reviews every generated fact before it is ever exported.
//
// Model + secret handling mirror `scorecard` exactly: fw_settings.models.resume_content
// falls back to models.default, falls back to 'claude-sonnet-5'. ANTHROPIC_API_KEY must be
// a Supabase secret, never hardcoded.

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export interface ResumeExperienceEntry {
  title: string;
  company: string;
  dates: string;
  location: string | null;
  bullets: string[];
}

export interface ResumeEducationEntry {
  credential: string;
  institution: string | null;
  dates: string | null;
}

export interface ResumeCertificationEntry {
  name: string;
  issuer: string | null;
  date: string | null;
}

export interface ResumeHighlightItem {
  title: string;
  body: string;
}

export interface ResumeHighlightSection {
  heading: string;
  items: ResumeHighlightItem[];
}

export interface ResumeContent {
  contact: {
    name: string | null;
    email: string | null;
    phone: string | null;
    linkedin: string | null;
    location: string | null;
    other: string | null;
  };
  summary: string;
  experience: ResumeExperienceEntry[];
  highlight?: ResumeHighlightSection;
  skills: string[];
  education: ResumeEducationEntry[];
  certifications: ResumeCertificationEntry[];
}

const RESUME_TOOL = {
  name: "emit_resume_content",
  description:
    "Emit structured resume content for this application. Every fact must trace back to the career record — never invent an achievement, title, employer, date, or credential not already present there.",
  input_schema: {
    type: "object",
    properties: {
      contact: {
        type: "object",
        properties: {
          name: { type: ["string", "null"] },
          email: { type: ["string", "null"] },
          phone: { type: ["string", "null"] },
          linkedin: { type: ["string", "null"] },
          location: { type: ["string", "null"] },
          other: { type: ["string", "null"], description: "e.g. a github/portfolio URL, if present in the record." },
        },
      },
      summary: {
        type: "string",
        description: "3-5 sentences, tailored to this JD, never exceeding the claims in locked_summary.",
      },
      experience: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            company: { type: "string" },
            dates: { type: "string" },
            location: { type: ["string", "null"] },
            bullets: { type: "array", items: { type: "string" } },
          },
          required: ["title", "company", "dates", "bullets"],
        },
      },
      highlight: {
        type: "object",
        description:
          "A tailored highlight section of 3-5 named things — products, initiatives, wins — pulled ONLY from the career record. Choose the heading for THIS job: 'Selected Impact' when the JD rewards outcomes and metrics, 'Flagship Products' when it rewards things built and shipped, or another short heading if the record and JD suggest a better fit.",
        properties: {
          heading: {
            type: "string",
            description: "Short section heading chosen per-job (e.g. 'Selected Impact', 'Flagship Products').",
          },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string", description: "The named product, initiative, or win — as named in the career record." },
                body: {
                  type: "string",
                  description: "1-2 sentences on it. Every fact must already exist in the career record.",
                },
              },
              required: ["title", "body"],
            },
          },
        },
        required: ["heading", "items"],
      },
      skills: { type: "array", items: { type: "string" }, description: "8-15 skills, all genuinely supported by the career record." },
      education: {
        type: "array",
        items: {
          type: "object",
          properties: {
            credential: { type: "string" },
            institution: { type: ["string", "null"] },
            dates: { type: ["string", "null"] },
          },
          required: ["credential"],
        },
      },
      certifications: {
        type: "array",
        description:
          "Certifications and security clearance from the career record (e.g. TS/SCI, AI-900, AZ-900). Include an active clearance FIRST when present — it is a major asset. Empty array only if the record truly lists none.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "The credential itself, e.g. 'TS/SCI' or 'AI-900'." },
            issuer: { type: ["string", "null"], description: "What it is / who issued it, e.g. 'Microsoft Azure AI Fundamentals' or 'DoD CAF'." },
            date: { type: ["string", "null"] },
          },
          required: ["name"],
        },
      },
      ats_keywords: {
        type: "array",
        items: { type: "string" },
        description: "Keywords pulled from the JD that the candidate's real background genuinely supports.",
      },
    },
    required: ["contact", "summary", "experience", "highlight", "skills", "education", "certifications", "ats_keywords"],
  },
};

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
    const { application_id } = body as { application_id?: string };
    if (!application_id) {
      return new Response(JSON.stringify({ error: "Provide application_id." }), {
        status: 400,
        headers: { ...CORS_HEADERS, "content-type": "application/json" },
      });
    }

    const [{ data: profile }, { data: settingsRows }, { data: application }, { data: jds }, { data: lessons }] =
      await Promise.all([
        supabase.from("fw_profile").select("*").limit(1).maybeSingle(),
        supabase.from("fw_settings").select("key, value"),
        supabase.from("fw_applications").select("*").eq("id", application_id).maybeSingle(),
        supabase
          .from("fw_jds")
          .select("*")
          .eq("application_id", application_id)
          .order("created_at", { ascending: false })
          .limit(1),
        supabase.from("fw_lessons").select("*").eq("application_id", application_id),
      ]);

    if (!application) {
      return new Response(JSON.stringify({ error: "No application found with that id." }), {
        status: 404,
        headers: { ...CORS_HEADERS, "content-type": "application/json" },
      });
    }

    const settings: Record<string, unknown> = {};
    for (const row of (settingsRows ?? []) as { key: string; value: unknown }[]) {
      settings[row.key] = row.value;
    }
    const model = resolveModel(settings, "resume_content");
    const jd = (jds ?? [])[0] as Record<string, unknown> | undefined;
    const profileRow = (profile ?? {}) as Record<string, unknown>;

    const systemPrompt = `You are building tailored resume content for Fieldwork, a job-search cockpit. The candidate's career record is the absolute ceiling: every bullet, title, employer, date, and credential you emit must already exist in the career record below. Never invent, exaggerate, or extrapolate an achievement, metric, or credential that isn't already stated there. Never claim anything listed in "do not claim". Never mention anything listed in "never mention". If the record doesn't contain enough detail for a section (e.g. education), leave that section as an empty array rather than inventing content.

Candidate career record (markdown, the ceiling for every claim):
${String(profileRow.career_record ?? "(none on file — do not invent one)")}

Locked summary (the ceiling for the summary specifically — the tailored summary you write must never claim more than this):
${String(profileRow.locked_summary ?? "(none on file)")}

Hooks (name -> reusable framing, may be woven in if relevant): ${JSON.stringify(profileRow.hooks ?? {})}
Do not claim: ${Array.isArray(profileRow.do_not_claim) ? (profileRow.do_not_claim as string[]).join(", ") : "(none)"}
Never mention: ${Array.isArray(profileRow.never_mention) ? (profileRow.never_mention as string[]).join(", ") : "(none)"}

Target role: ${application.title ?? "(untitled)"} at ${application.company}.
Job description pain line: ${jd?.pain_line ?? "(none captured)"}
Job description gaps noted at scorecard time: ${Array.isArray(jd?.gaps) ? (jd!.gaps as unknown[]).join(", ") : "(none)"}
Job description text: ${String(jd?.raw_text ?? "(no JD text on file — tailor generically from the career record)")}
Lessons learned from this application so far: ${JSON.stringify(lessons ?? [])}

Produce resume content tailored to this specific role: prioritize and rephrase (never invent) the career-record bullets that best answer the pain line and close the noted gaps where the record genuinely supports it. Extract the contact block (name/email/phone/linkedin/location/other) directly from the career record text if present there; otherwise leave those fields null — never fabricate contact details.

Length: the assembled resume should closely fill TWO full pages — not less. Aim for roughly: a 3-5 sentence summary; 5-8 bullets for each recent or substantial role and 3-5 for older ones; the highlight section; 10-15 skills; certifications and clearance; education. Include EVERY genuinely relevant role the record contains (do not silently drop the most recent role or any real position), and pull additional real bullets and fuller detail the record already contains before ever leaving a page short. Depth comes from the record, never from invention; the ceiling rule is absolute even when filling space.

Certifications and clearance: emit a certifications array from the record. If the record states an active security clearance (e.g. TS/SCI), list it FIRST — it is one of the strongest signals on the resume and must never be omitted when present.

Highlight section: also emit a tailored highlight section — 3-5 items, each a named thing (a product, an initiative, a win) with a 1-2 sentence body, pulled ONLY from the career record. Every fact in every item must already exist in the record; do-not-claim and never-mention still bind here. Choose the section heading for this specific job: "Selected Impact" when the JD rewards outcomes and metrics, "Flagship Products" when it rewards things built and shipped, or another short heading if the record and JD together suggest a better fit.

Style rule, absolute: NEVER use em dashes (—) or double hyphens (--) anywhere in any emitted text (summary, bullets, highlight bodies, everything). Where you would reach for an em dash, restructure the sentence or use a period, comma, or colon instead. Plain hyphens inside compound words are fine.

Call emit_resume_content with your result — do not respond in plain text.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 8000,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: "Build the tailored resume content for this application now.",
          },
        ],
        tools: [RESUME_TOOL],
        tool_choice: { type: "tool", name: "emit_resume_content" },
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Claude API error (${res.status}): ${detail.slice(0, 500)}`);
    }

    const payload = await res.json();
    const toolUse = (payload.content ?? []).find((b: { type: string }) => b.type === "tool_use");
    if (!toolUse) {
      throw new Error("Claude did not return structured resume content.");
    }
    const input = toolUse.input as Record<string, unknown>;

    const content: ResumeContent = {
      contact: {
        name: (input.contact as Record<string, unknown>)?.name as string | null ?? null,
        email: (input.contact as Record<string, unknown>)?.email as string | null ?? null,
        phone: (input.contact as Record<string, unknown>)?.phone as string | null ?? null,
        linkedin: (input.contact as Record<string, unknown>)?.linkedin as string | null ?? null,
        location: (input.contact as Record<string, unknown>)?.location as string | null ?? null,
        other: (input.contact as Record<string, unknown>)?.other as string | null ?? null,
      },
      summary: String(input.summary ?? ""),
      experience: Array.isArray(input.experience) ? (input.experience as ResumeExperienceEntry[]) : [],
      skills: Array.isArray(input.skills) ? (input.skills as string[]) : [],
      education: Array.isArray(input.education) ? (input.education as ResumeEducationEntry[]) : [],
      certifications: Array.isArray(input.certifications)
        ? (input.certifications as ResumeCertificationEntry[])
        : [],
    };
    // Highlight section is optional in the output shape — tolerate a missing/malformed one.
    const rawHighlight = input.highlight as { heading?: unknown; items?: unknown } | undefined;
    if (rawHighlight && typeof rawHighlight.heading === "string" && Array.isArray(rawHighlight.items)) {
      const items = (rawHighlight.items as { title?: unknown; body?: unknown }[])
        .filter((it) => typeof it?.title === "string" && typeof it?.body === "string")
        .map((it) => ({ title: it.title as string, body: it.body as string }));
      if (items.length > 0) {
        content.highlight = { heading: rawHighlight.heading, items };
      }
    }
    const ats_keywords = Array.isArray(input.ats_keywords) ? (input.ats_keywords as string[]) : [];

    // Hard backstop for the no-em-dash style rule across every text field.
    const stripEmDashes = <T>(value: T): T => {
      if (typeof value === "string") {
        return value
          // date ranges ("2022 — Present") keep a plain hyphen…
          .replace(/(\d{4}|\bPresent\b)\s*(?:—|--)\s*(?=\d{4}|\bPresent\b)/gi, "$1 - ")
          // …everything else reads as a comma
          .replace(/\s*—\s*/g, ", ")
          .replace(/\s*--\s*/g, ", ") as unknown as T;
      }
      if (Array.isArray(value)) return value.map(stripEmDashes) as unknown as T;
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, stripEmDashes(v)])
        ) as unknown as T;
      }
      return value;
    };
    const cleaned = stripEmDashes(content);

    return new Response(JSON.stringify({ content: cleaned, ats_keywords }), {
      headers: { ...CORS_HEADERS, "content-type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error in resume_content." }),
      { status: 500, headers: { ...CORS_HEADERS, "content-type": "application/json" } }
    );
  }
});
