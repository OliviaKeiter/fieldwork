// Supabase Edge Function: sweep
//
// SPEC.md §6/§9 Phase 4: "reads mail via provider API, classifies, updates rows + lessons."
//
// IMPORTANT — autonomous limitation, read before wiring this up:
// There is no mail-provider OAuth app configured for this Supabase project, and no
// credentials exist to set one up from here. The inbox sweep user #1 runs today is
// a Claude Code scheduled task with its own mail MCP connector — that access is out
// of reach for a server-side edge function deployed autonomously. So this function does NOT
// fetch mail itself. It accepts a client/job-supplied payload of already-fetched email
// summaries:
//   POST { items: [{ from, subject, snippet, received_at }, ...] }
// and does the two things Phase 4 actually needs done in the app's own data model:
//   1. classify each item against existing fw_applications (rejection / interview_invite /
//      other) using Claude, matched by company name found in from/subject/snippet
//   2. write results:
//        - rejection  -> status update to 'rejected' + fw_events (status_change, reuses the
//          exact Pipeline drag-to-reject shape) + fw_lessons row (stated_reason pulled from
//          the email), mirroring recordRejection() in app/src/lib/applications.ts /
//          RejectionModal.tsx exactly rather than re-inventing the write shape
//        - interview_invite -> NOT auto-applied. Inserts an fw_events 'note' row surfacing
//          the invite so a human confirms the status change in Pipeline, per the task brief
//          ("surfaced but not auto-applied")
//        - other / unmatched -> returned in the response for visibility, nothing written
//
// To wire this up for real autonomous operation later, the user needs to either:
//   (a) register an OAuth app with their mail provider (Microsoft Graph / Gmail API), store
//       the resulting client id/secret + refresh token as Supabase secrets, and add a fetch
//       step here that pulls unread mail before classification, or
//   (b) keep mail-fetching in Claude Code (the existing scheduled task already has mailbox
//       access) and have that job POST its fetched-item summaries to this function's URL —
//       no code change needed on this end, this function is already shaped to receive that.
// Either path reuses this function's classify+write logic unchanged.
//
// Model + secret handling mirror daily_loop/scorecard exactly: fw_settings.models.sweep
// falls back to models.default, falls back to 'claude-sonnet-5'; ANTHROPIC_API_KEY must be
// a Supabase secret, never hardcoded.

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface MailItem {
  from: string;
  subject: string;
  snippet: string;
  received_at?: string | null;
}

interface ApplicationRow {
  id: string;
  company: string;
  title: string | null;
  status: string;
}

interface ClassifyResult {
  application_id: string | null;
  classification: "rejection" | "interview_invite" | "other";
  stated_reason: string | null;
  confidence: "high" | "medium" | "low";
  reasoning: string;
}

const CLASSIFY_TOOL = {
  name: "emit_classification",
  description:
    "Classify a single email against the candidate's known job applications and emit the result.",
  input_schema: {
    type: "object",
    properties: {
      application_id: {
        type: ["string", "null"],
        description:
          "The id of the matching application from the provided list, or null if no confident match.",
      },
      classification: {
        type: "string",
        enum: ["rejection", "interview_invite", "other"],
      },
      stated_reason: {
        type: ["string", "null"],
        description:
          "For a rejection only: the reason the company gave, in their own words/paraphrase. Null otherwise.",
      },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      reasoning: { type: "string" },
    },
    required: ["classification", "confidence", "reasoning"],
  },
};

function resolveModel(settings: Record<string, unknown>, action: string): string {
  const models = (settings.models ?? {}) as Record<string, string>;
  return models[action] ?? models.default ?? "claude-sonnet-5";
}

async function classifyItem(opts: {
  item: MailItem;
  applications: ApplicationRow[];
  model: string;
  apiKey: string;
}): Promise<ClassifyResult> {
  const { item, applications, model, apiKey } = opts;

  const roster = applications
    .map((a) => `- id=${a.id} | ${a.company} | ${a.title ?? "(no title)"} | status=${a.status}`)
    .join("\n");

  const systemPrompt = `You are triaging one email for Fieldwork, a job-search cockpit, against the candidate's known open applications. Match the email to an application by company name (and title if helpful) mentioned in the from address, subject, or snippet. Only match with confidence "high" or "medium" if the company clearly corresponds to a roster entry; otherwise leave application_id null and use classification "other".

Known applications (id | company | title | current status):
${roster || "(none on file)"}

Classify the email as:
- "rejection": the company is declining/passing on the candidate for this role.
- "interview_invite": the company is inviting the candidate to a screen/interview/next round.
- "other": anything else (automated ATS confirmation, newsletter, unrelated, unclear).

For a rejection, extract stated_reason as a short paraphrase of whatever reason (if any) the email gives — null if none given. Call emit_classification with your result — do not respond in plain text.`;

  const userMessage = `From: ${item.from}\nSubject: ${item.subject}\nReceived: ${item.received_at ?? "(unknown)"}\n\nSnippet:\n${item.snippet}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 800,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      tools: [CLASSIFY_TOOL],
      tool_choice: { type: "tool", name: "emit_classification" },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Claude API error (${res.status}): ${detail.slice(0, 500)}`);
  }

  const payload = await res.json();
  const toolUse = (payload.content ?? []).find((b: { type: string }) => b.type === "tool_use");
  if (!toolUse) throw new Error("Claude did not return a structured classification.");
  const input = toolUse.input as Partial<ClassifyResult>;
  return {
    application_id: input.application_id ?? null,
    classification: input.classification ?? "other",
    stated_reason: input.stated_reason ?? null,
    confidence: input.confidence ?? "low",
    reasoning: input.reasoning ?? "",
  };
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
    const items = (body as { items?: MailItem[] }).items ?? [];

    if (!Array.isArray(items) || items.length === 0) {
      return new Response(
        JSON.stringify({
          error:
            "Provide a non-empty items array of already-fetched email summaries: { items: [{ from, subject, snippet, received_at }] }. This function has no mail-provider access of its own — see the file header for why and how to wire that up.",
        }),
        { status: 400, headers: { ...CORS_HEADERS, "content-type": "application/json" } }
      );
    }

    const [{ data: settingsRows }, { data: apps }] = await Promise.all([
      supabase.from("fw_settings").select("key, value"),
      supabase
        .from("fw_applications")
        .select("id, company, title, status")
        .not("status", "in", '("rejected","withdrawn","accepted")'),
    ]);

    const settings: Record<string, unknown> = {};
    for (const row of (settingsRows ?? []) as { key: string; value: unknown }[]) {
      settings[row.key] = row.value;
    }
    const model = resolveModel(settings, "sweep");
    const applications = (apps ?? []) as ApplicationRow[];

    const results = await Promise.all(
      items.map(async (item) => {
        try {
          const classified = await classifyItem({ item, applications, model, apiKey });
          return { item, ...classified, action: "none" as string };
        } catch (err) {
          return {
            item,
            application_id: null,
            classification: "other" as const,
            stated_reason: null,
            confidence: "low" as const,
            reasoning: "",
            error: err instanceof Error ? err.message : "Classification failed.",
            action: "none" as string,
          };
        }
      })
    );

    // Write results. Low-confidence matches are surfaced but not written — a human should
    // confirm those from the item's `reasoning` in the response.
    for (const r of results) {
      if (!r.application_id || r.confidence === "low") continue;
      const app = applications.find((a) => a.id === r.application_id);
      if (!app) continue;

      if (r.classification === "rejection") {
        // Mirrors recordRejection() in app/src/lib/applications.ts exactly: status ->
        // rejected, a status_change event, and an fw_lessons row with the stated reason.
        const { error: statusErr } = await supabase
          .from("fw_applications")
          .update({ status: "rejected" })
          .eq("id", app.id);
        if (statusErr) continue;

        await supabase.from("fw_events").insert({
          application_id: app.id,
          type: "status_change",
          body: `${app.status} → rejected (via sweep)`,
          occurred_at: item.received_at ?? new Date().toISOString(),
        });

        await supabase.from("fw_lessons").insert({
          application_id: app.id,
          company: app.company,
          role: app.title,
          date: new Date().toISOString().slice(0, 10),
          stage_reached: app.status,
          stated_reason: r.stated_reason,
        });

        r.action = "rejected + lesson logged";
      } else if (r.classification === "interview_invite") {
        // Surfaced, not auto-applied: a note event only. The human confirms the status
        // change (e.g. -> phone_screen / interviewing) in Pipeline.
        await supabase.from("fw_events").insert({
          application_id: app.id,
          type: "note",
          body: `Sweep detected a possible interview invite (via sweep): "${item.subject}" — confirm and update status in Pipeline if correct.`,
          occurred_at: item.received_at ?? new Date().toISOString(),
        });

        r.action = "interview invite surfaced as note — confirm status manually";
      }
    }

    return new Response(JSON.stringify({ results }), {
      headers: { ...CORS_HEADERS, "content-type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error in sweep." }),
      { status: 500, headers: { ...CORS_HEADERS, "content-type": "application/json" } }
    );
  }
});
