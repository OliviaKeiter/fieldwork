> **Note:** This is the original build spec for Fieldwork (working title "JobSearch OS"),
> kept as documentation of how the app was designed. Some phase/migration details are
> specific to the original build and don't apply to self-hosted installs.

# JobSearch OS — Spec v1 (the original build spec, kept as documentation)

**One line:** the job-search system as an app — every action that today is a sentence typed
to Claude becomes a button or selector; every fact lives in Supabase; the human clicks
submit and sends messages, exactly as before.

**Decisions already locked (2026-07-10):** me-first, product-shaped (single user now, no
hardcoded personal facts anywhere, multi-user-ready schema). Hybrid engine (app owns data
and quick AI moves via edge functions; Claude Code keeps heavy jobs, writing to the same
database). Groundwork: Sonnet 5 builds it.

---

## 1. Principles (inherit from the playbook, non-negotiable)

1. **The career record is the ceiling.** Every AI action reads the record from the
   database; nothing generated may exceed it. The record editor displays this rule.
2. **Drafts only.** The app never sends anything. Every outbound artifact ends at a
   "Copy" / "Open in mail" button and a [Mark sent] the user clicks after sending.
3. **Buttons, not typing.** If the user could say it to Claude, there is a control for it.
   The full inventory is §5 — this is the core feature, not a nice-to-have.
4. **Fully customizable.** No user fact, threshold, phrase, or rule in code. Everything in
   `settings`/`profile` with a UI. The operator is user #1, not the default values.
5. **Nothing breaks the running search.** The xlsx tracker stays a live mirror until the
   Phase 4 gate. Claude Code skills keep working throughout.
6. **Dark mode is the default.** Light mode is the toggle. Both first-class.
7. **Whimsy, gently.** Warm microcopy and small delights; never cute about rejection — this
   covers low grades (D/F stay plain and factual: a grade describes a posting, not the
   candidate) and the auto-ghost notice.

## 2. Stack

- **Frontend:** Astro + React islands, Tailwind. Netlify deploy. Responsive (phone-usable);
  PWA installable.
- **Data:** Supabase Postgres. RLS on from day one keyed to a single user id (auth arrives
  with multi-user, schema won't change).
- **AI:** Supabase Edge Functions calling the Claude API. Default model `claude-sonnet-5`;
  per-action model override in settings. API key stored as a Supabase secret, never in the
  client.
- **Heavy engine:** Claude Code sessions (resume .docx/.pdf builds, deep interview prep,
  the inbox sweep until Phase 4) read/write the same Supabase via MCP.

## 3. Data model

| Table | Key columns (beyond id/timestamps) |
|---|---|
| `profile` | career_record (markdown), locked_summary, hooks jsonb (name→text), comp_floor, target_band_strategy, remote_prefs, target_titles[], avoid_titles[], do_not_claim[], never_mention[], file_name_pattern |
| `settings` | key, value jsonb — timing rules (nudge_days=5–7, ghost_days=30, thankyou_hours=24), theme, whimsy_level, per-action model map, board columns |
| `applications` | company, title, status (enum: to_apply, applied, phone_screen, interviewing, final_round, offer, accepted, rejected, withdrawn, ghosted), date_applied, grade (enum: A+/A/B/C/D/F — the scorecard's letter grade for the role), comp_posted, comp_min, comp_max, remote_type, source, next_action, next_action_due, resume_filename, cover_letter bool |
| `jds` | application_id, url, raw_text, pain_line, gaps jsonb, live_checked_at, source |
| `contacts` | name, company, role_title, context, email, phone, linkedin, application_id (nullable — standing contacts exist), last_touch, next_action, warmth (cold/warm/hot) |
| `events` | application_id, type (applied, screen, round, debrief, rejection, nudge, thank_you, note, status_change), occurred_at, body — the per-role timeline |
| `intake_runs` | kind (scorecard/daily_loop_paste/daily_loop_source), ran_at, requested, searched_queries[], candidates, duplicates, expired, errors, scored, grades jsonb (histogram), model — one row per scorecard/daily-loop call, written server-side. Only filed/discarded roles reach `applications`, so this is the only record of the denominator |
| `lessons` | application_id (nullable), date, stage_reached, stated_reason, real_signal, adjustment |
| `drafts` | parent (application_id or contact_id), type (hello, nudge, thank_you, stay_in_touch, cover_letter), body, status (draft/sent), sent_at |
| `prep_docs` | application_id, content (markdown), round_type, debriefs jsonb |

## 4. Screens

1. **Today** (home) — the forward-looking queue: what went out today, what needs you today
   and tomorrow, and what interviews are booked ahead. One card each, one button each.
   Silence is not shown as a backlog — applications past `timing.ghost_days` are
   auto-ghosted and reported after the fact (§5).
2. **Pipeline** — kanban by status, drag to move (writes a status_change event), filters,
   aging badges, NEXT-due indicators.
3. **Intake** — paste JD text or URL. Liveness check → scorecard → graded card → file it.
4. **Dossier** (per company) — tabs: Overview/timeline · JD · Resume · Contacts · Prep.
5. **Contacts** — table + aging ("18 days quiet"), warmth chips, draft buttons.
6. **Insights** — intake performance (runs, drop-off funnel, grade spread, match rate),
   funnel chart, deaths-by-stage, rejection reasons clustered, title win-rates, weekly
   velocity. The lessons log rendered as evidence. Intake stats read `intake_runs`, never
   `applications`: the pipeline only holds roles that were filed or discarded, so it can say
   what was kept but never out of how many.
7. **Settings** — profile & career record editor, rules, hooks, models, theme, data
   export (csv/markdown — the user's data walks out the door freely).
8. **Onboarding wizard** (product-shaped requirement) — the resume-builder setup interview
   as screens: record builder, rules, hooks, titles. The common path: "import existing."

## 5. The Button Inventory (chat phrase → control)

| Today I type… | In the app |
|---|---|
| "run the daily loop" | **[Run daily loop]** on Today → edge fn sources N roles (configurable titles/boards), liveness-checks, scorecards each → verdict cards stack up for review |
| "is this a good fit?" (paste JD) | Intake paste box → **[Scorecard]** |
| "build AnswerRocket" | **[Build resume]** on a YES card → Phase 3 in-app, until then it queues a Claude Code job card with copy-ready instruction |
| "who do I need to follow up with?" | The Today queue itself (auto-computed from timing rules) |
| "draft a nudge for X" | **[Draft nudge]** on any silent row → draft panel → [Copy] [Mark sent] |
| "thank-you for [interviewer]" | **[Draft thank-you]** on a debrief |
| "log: interview Tuesday" | **[Log event ▾]** selector on dossier (screen/round/offer/rejection + date picker) |
| "Modaxo is a no" | Drag card to Rejected → modal asks stated reason → lessons row auto-created |
| "prep me for [company]" | **[Prep me]** on dossier → prep doc generated from stored JD + record |
| "here's how it went" | **[Log debrief]** form → feeds thank-you draft button |
| "pipeline update" | **[Weekly review]** button → runs the ritual, renders the one-line summary + report |
| "sweep my inbox" | **[Sweep now]** — paste-in classifier (§9 Phase 4). Fieldwork holds no mailbox credentials; the `daily-rejection-sweep` Claude Code task already reads the mailbox and can POST to the `sweep` edge function without any OAuth app being registered. |
| "mark it ghosted" | Auto-applied once `timing.ghost_days` of silence passes; Today reports the sweep after the fact, and the row stays draggable in Pipeline. A booked future interview always blocks it. |
| "add recruiter Jane, TA at Acme" | **[+ Contact]** with company autocomplete |
| "what's my floor / change my floor" | Settings → Rules |

Rule of thumb enforced in review: **any new capability ships with its control.** If a
feature is only reachable by talking to Claude, it isn't done.

## 6. Edge functions (all read `profile` first; all respect the ceiling)

- Every scorecard/daily-loop call logs a row to `intake_runs` before returning. Logging is
  best-effort and never fails the user's request.
- `scorecard(jd_text|url)` — liveness check, extract comp/location/reqs, letter grade per the
  resume-builder order (comp → location → contract → blockers → degree), returns the card.
- `daily_loop(count)` — search (configurable sources) → dedupe vs. existing applications →
  liveness → scorecard each → insert to_apply rows + jds.
- `draft(type, context_ids)` — networking-outreach rules: one hook, one ask, length caps.
- `prep(application_id, round_type)` — interview-prep structure from stored JD + record +
  lessons.
- `resume_content(application_id)` — Phase 3: ATS keyword pass + content JSON; client
  renders .docx via docx.js and .pdf via print stylesheet. (Until then: Claude Code job.)
- `sweep()` — Phase 4: reads mail via provider API, classifies, updates rows + lessons.

## 7. Design & whimsy

- Design tokens pulled from the existing whimsy-app design system at build time (single
  source; dark palette first, light derived).
- Dark default; toggle persisted per user.
- **Whimsy dial in settings (off / gentle / full):** growth microcopy ("3 seedlings
  planted today"), a small companion garden — each active application is a sprout, offers
  bloom. Confetti on Offer, always. Rejections stay plain and kind: "Logged. Their loss is
  the pattern library's gain." Ghosted = "energy banked." Whimsy NEVER on rejection modals
  at any dial setting.
- Empty states do the teaching (an empty Today queue says what healthy looks like).
- Any AI call that takes more than a beat renders `BuildProgress` with stage labels that
  describe the real steps that function performs — never a bare disabled button, which
  reads as a hang. Applies to scorecard, daily loop, sweep, drafts, prep, resume builds.

## 8. Migration & mirror

1. Import script: existing tracker rows + saved JDs + contacts + lessons-learned notes →
   Supabase (one-time, idempotent, dry-run mode first).
2. During Phases 1–3: Claude Code sync step keeps the xlsx mirror updated FROM Supabase
   (one direction after cutover day; the app becomes write-primary the day Phase 1 ships).
   The 8:01 sweep writes to Supabase and the mirror follows.
3. Phase 4 gate: 2 clean weeks of app-primary operation → xlsx retired to archive.

## 9. Phases & gates

| Phase | Ships | Gate to next |
|---|---|---|
| 0 — Kit | This spec locked; Supabase project + schema + RLS; import dry-run report | Spec locked; import numbers match tracker |
| 1 — Cockpit | Today queue, Pipeline board, dossiers (read + status/events/notes), Settings core, dark/light, import for real | One full week run from the app without opening Excel |
| 2 — Intake | Scorecard fn, daily-loop fn, verdict cards, JD library | A real application sourced→scored→applied entirely in-app |
| 3 — Studio | resume_content fn + docx/pdf in browser, prep docs, draft panel everywhere | A real resume submitted from an app build |
| 4 — Cut the cord | Server-side sweep, Insights, mirror retired, onboarding wizard polished | 2 clean weeks; then decide: friends beta? |

## 10. Non-goals (v1)

Multi-user auth & billing, hosted shared API keys, native mobile apps, auto-submit of
applications (never — the human clicks submit), scraping ATS boards beyond public pages.

## 11. Open questions

1. Supabase project: new project (~$0 free tier fits) or share an existing one?
2. Sourcing inside `daily_loop`: web search API choice (Brave/Tavily/etc.) — has cost;
   or Phase 2 keeps sourcing as a Claude Code job that deposits candidates into the app?
3. Resume templates: port your 4 .docx templates to docx.js, or keep resume builds in
   Claude Code permanently (they're already excellent there)?
4. Whimsy default: gentle or full?
5. Name check: "JobSearch OS" — keep, or does it want a different name?
