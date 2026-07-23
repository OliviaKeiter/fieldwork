// Supabase Edge Function: prep
//
// Phase 3 "Studio" (SPEC.md §6). Given application_id + round_type, reads fw_profile (the
// ceiling), the target application's fw_jds, and any fw_lessons tied to that application (or
// application-agnostic lessons, which still carry pattern signal), then calls Claude to
// produce an interview-prep markdown doc: likely questions for this round type, a story bank
// pulled from the career record, gaps to address head-on, and questions to ask them.
//
// Unlike scorecard/resume_content, this function DOES write the result to fw_prep_docs
// itself (one row per application+round_type, upserted) per the task brief — the [Prep me]
// button both generates and persists in one call, and "Log debrief" appends to the same
// row's debriefs jsonb column afterward from the client.
//
// Model + secret handling mirror `scorecard`: fw_settings.models.prep falls back to
// models.default, falls back to 'claude-sonnet-5'. ANTHROPIC_API_KEY must be a Supabase
// secret, never hardcoded.

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PREP_TOOL = {
  name: "emit_prep_doc",
  description: "Emit the interview-prep markdown document for this round.",
  input_schema: {
    type: "object",
    properties: {
      markdown: {
        type: "string",
        description:
          "A well-structured markdown document with sections: '## Likely questions', '## Story bank' (pulled/adapted from the career record, never invented), '## Gaps to address' (honest, from the JD gaps and lessons on file), and '## Questions to ask them'.",
      },
    },
    required: ["markdown"],
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
    const { application_id, round_type } = body as { application_id?: string; round_type?: string };
    if (!application_id) {
      return new Response(JSON.stringify({ error: "Provide application_id." }), {
        status: 400,
        headers: { ...CORS_HEADERS, "content-type": "application/json" },
      });
    }
    const roundType = round_type && round_type.trim() ? round_type.trim() : "general";

    const [{ data: profile }, { data: settingsRows }, { data: application }, { data: jds }, { data: lessons }, { data: existingDoc }] =
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
        supabase.from("fw_lessons").select("*").or(`application_id.eq.${application_id},application_id.is.null`),
        supabase
          .from("fw_prep_docs")
          .select("*")
          .eq("application_id", application_id)
          .eq("round_type", roundType)
          .maybeSingle(),
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
    const model = resolveModel(settings, "prep");
    const jd = (jds ?? [])[0] as Record<string, unknown> | undefined;
    const profileRow = (profile ?? {}) as Record<string, unknown>;
    const priorDebriefs = Array.isArray(existingDoc?.debriefs) ? existingDoc!.debriefs : [];

    const systemPrompt = `You are building interview-prep material for Fieldwork, a job-search cockpit. The candidate's career record is the ceiling: every story in the story bank must be pulled or lightly adapted from the record below — never invent an anecdote, metric, or achievement not already present there. Never suggest claiming anything in "do not claim"; never suggest mentioning anything in "never mention".

Candidate career record (markdown):
${String(profileRow.career_record ?? "(none on file)")}

Locked summary: ${String(profileRow.locked_summary ?? "(none on file)")}
Hooks (name -> reusable framing): ${JSON.stringify(profileRow.hooks ?? {})}
Do not claim: ${Array.isArray(profileRow.do_not_claim) ? (profileRow.do_not_claim as string[]).join(", ") : "(none)"}
Never mention: ${Array.isArray(profileRow.never_mention) ? (profileRow.never_mention as string[]).join(", ") : "(none)"}

Role: ${application.title ?? "(untitled)"} at ${application.company}. Round type: ${roundType}.
Job description pain line: ${jd?.pain_line ?? "(none captured)"}
Job description gaps: ${Array.isArray(jd?.gaps) ? (jd!.gaps as unknown[]).join(", ") : "(none)"}
Job description text: ${String(jd?.raw_text ?? "(no JD text on file)")}
Lessons learned across this search (rejection patterns, real signals, adjustments): ${JSON.stringify(lessons ?? [])}
Debriefs already logged for this round: ${JSON.stringify(priorDebriefs)}

Write a markdown prep doc with sections: likely questions for this specific round type at this company, a story bank of real stories from the record mapped to likely themes, an honest list of gaps to address head-on (from the JD gaps and any rejection patterns in lessons learned), and sharp questions to ask the interviewer that surface real signal about the role.

Style rule, absolute: NEVER use em dashes (—) or double hyphens (--) anywhere in the output; restructure the sentence or use a period, comma, or colon instead. Plain hyphens inside compound words are fine.

Call emit_prep_doc with your result — do not respond in plain text.`;

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
        messages: [{ role: "user", content: `Build the ${roundType} interview prep doc now.` }],
        tools: [PREP_TOOL],
        tool_choice: { type: "tool", name: "emit_prep_doc" },
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Claude API error (${res.status}): ${detail.slice(0, 500)}`);
    }

    const payload = await res.json();
    if (payload.stop_reason === "max_tokens") {
      throw new Error(
        "Prep doc generation ran out of output tokens before finishing (stop_reason max_tokens) — the tool payload would be truncated. Not saving a partial doc; retry, and if it recurs raise max_tokens further."
      );
    }
    const toolUse = (payload.content ?? []).find((b: { type: string }) => b.type === "tool_use");
    if (!toolUse) {
      throw new Error("Claude did not return a prep doc.");
    }
    const markdown = String((toolUse.input as { markdown?: string }).markdown ?? "");
    if (!markdown.trim()) {
      throw new Error(
        "Claude returned an empty prep doc (likely a truncated or malformed tool payload). Not saving it — retry."
      );
    }

    let savedDoc;
    if (existingDoc) {
      const { data, error } = await supabase
        .from("fw_prep_docs")
        .update({ content: markdown })
        .eq("id", existingDoc.id)
        .select()
        .single();
      if (error) throw error;
      savedDoc = data;
    } else {
      const { data, error } = await supabase
        .from("fw_prep_docs")
        .insert({ application_id, round_type: roundType, content: markdown, debriefs: [] })
        .select()
        .single();
      if (error) throw error;
      savedDoc = data;
    }

    return new Response(JSON.stringify({ prep_doc: savedDoc }), {
      headers: { ...CORS_HEADERS, "content-type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error in prep." }),
      { status: 500, headers: { ...CORS_HEADERS, "content-type": "application/json" } }
    );
  }
});
