-- Fieldwork schema
-- Run this file in the Supabase SQL editor (or via `supabase db push`) on a fresh project.
-- Creates the 7 enums, 11 fw_ tables, enables RLS, and adds authenticated-only policies.
-- Safe to run top-to-bottom exactly once on a fresh project.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- 'passed' = decided not to pursue a role you never applied to. The row is kept rather than
-- deleted so daily_loop's company+title dedupe keeps the posting out of future sourcing runs.
create type fw_status as enum (
  'to_apply', 'applied', 'phone_screen', 'interviewing', 'final_round',
  'offer', 'accepted', 'rejected', 'withdrawn', 'ghosted', 'passed'
);

-- Scorecard grade for a role. Declared best-to-worst so Postgres's natural enum ordering
-- sorts strongest-first for free.
create type fw_grade as enum ('A+', 'A', 'B', 'C', 'D', 'F');
create type fw_run_kind as enum ('scorecard', 'daily_loop_paste', 'daily_loop_source');
create type fw_run_outcome as enum ('graded', 'duplicate', 'expired', 'error');

create type fw_event_type as enum (
  'applied', 'screen', 'round', 'debrief', 'rejection', 'nudge',
  'thank_you', 'note', 'status_change', 'offer'
);

create type fw_draft_type as enum (
  'hello', 'nudge', 'thank_you', 'stay_in_touch', 'cover_letter', 'application_question'
);

create type fw_draft_status as enum ('draft', 'sent');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table fw_profile (
  id uuid primary key default gen_random_uuid(),
  career_record text,
  locked_summary text,
  hooks jsonb not null default '{}'::jsonb,
  comp_floor integer,
  target_band_strategy text,
  remote_prefs text,
  target_titles text[] not null default '{}'::text[],
  avoid_titles text[] not null default '{}'::text[],
  do_not_claim text[] not null default '{}'::text[],
  never_mention text[] not null default '{}'::text[],
  file_name_pattern text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table fw_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table fw_applications (
  id uuid primary key default gen_random_uuid(),
  company text not null,
  title text,
  status fw_status not null default 'to_apply',
  date_applied date,
  grade fw_grade,
  comp_posted text,
  comp_min integer,
  comp_max integer,
  remote_type text,
  source text,
  next_action text,
  next_action_due date,
  resume_filename text,
  -- Last built (post-edit) resume JSON, so a past build can be viewed/re-exported.
  resume_content jsonb,
  cover_letter boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table fw_jds (
  id uuid primary key default gen_random_uuid(),
  application_id uuid references fw_applications(id) on delete cascade,
  url text,
  raw_text text,
  pain_line text,
  gaps jsonb not null default '[]'::jsonb,
  live_checked_at timestamptz,
  source text,
  created_at timestamptz not null default now()
);

create table fw_contacts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  company text,
  role_title text,
  context text,
  email text,
  phone text,
  linkedin text,
  application_id uuid references fw_applications(id) on delete set null,
  last_touch date,
  next_action text,
  warmth text not null default 'cold',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table fw_events (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references fw_applications(id) on delete cascade,
  type fw_event_type not null,
  occurred_at date not null default current_date,
  -- When a screen/round/debrief is booked for. Null = not scheduled, or already happened.
  -- A future value means the event has NOT occurred yet: it must not trigger a thank-you,
  -- but it still counts as contact for ghost detection (a booked interview is the opposite
  -- of silence). Today's "upcoming" section reads this column.
  scheduled_at timestamptz,
  body text,
  created_at timestamptz not null default now()
);

create index fw_events_scheduled_at_idx
  on fw_events (scheduled_at) where scheduled_at is not null;

-- One row per scorecard / daily_loop invocation.
--
-- Why this table exists: daily_loop already computes how many queries it searched, how many
-- candidates came back, how many were duplicates/expired/failed, and every grade it
-- assigned — then returns it all to the browser, which renders cards and drops the totals.
-- Only the handful the user files or discards ever reach fw_applications, so the
-- denominator ("out of how many?") was unrecoverable and the intake funnel could not be
-- measured. The edge functions write here because they know the true counts.
create table fw_intake_runs (
  id uuid primary key default gen_random_uuid(),
  kind fw_run_kind not null,
  ran_at timestamptz not null default now(),
  -- Roles asked for (source runs). Null when the count is whatever was pasted in.
  requested integer,
  -- Search queries issued (source runs only) — what it actually went looking for.
  searched_queries text[] not null default '{}',
  -- Candidates that reached the scoring stage gate, before dedupe/liveness.
  candidates integer not null default 0,
  -- Funnel dropouts, counted before any Claude call is spent on them.
  duplicates integer not null default 0,
  expired integer not null default 0,
  errors integer not null default 0,
  -- Candidates that were actually graded.
  scored integer not null default 0,
  -- Grade histogram for this run: {"A": 2, "B": 5, ...}. Denormalized on purpose — the
  -- per-role grade only survives in fw_applications for rows the user filed or discarded,
  -- so this is the only record of what a run actually produced.
  grades jsonb not null default '{}'::jsonb,
  model text,
  created_at timestamptz not null default now()
);

create index fw_intake_runs_ran_at_idx on fw_intake_runs (ran_at desc);

-- One row per role a run looked at — the card itself, not just a tally.
--
-- Why: fw_intake_runs records that a run graded 8 roles C/D/F, but not WHICH roles or WHY,
-- so a bad run could only be diagnosed by inference. Worse, a scored card lived only in the
-- HTTP response: if the browser failed to render it, the Claude call was spent and the
-- result was gone — the only recovery was re-running and paying twice. Storing the card lets
-- a run be reopened and filed later, and a surprising grade be read rather than guessed at.
--
-- jd_text is kept because fileAsToApply needs it to write the fw_jds row; without it a
-- reopened card could be read but not filed, which defeats the point.
create table fw_intake_run_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references fw_intake_runs(id) on delete cascade,
  company text not null,
  title text,
  url text,
  outcome fw_run_outcome not null,
  -- Set only when outcome = 'graded'.
  grade fw_grade,
  comp_min integer,
  comp_max integer,
  remote_type text,
  location text,
  pain_line text,
  gaps jsonb not null default '[]'::jsonb,
  reasoning text,
  jd_text text,
  live_checked_at timestamptz,
  liveness_note text,
  -- Set only when outcome = 'error'.
  error text,
  created_at timestamptz not null default now()
);

create index fw_intake_run_items_run_id_idx on fw_intake_run_items (run_id);
create index fw_intake_run_items_grade_idx on fw_intake_run_items (grade) where grade is not null;

create table fw_lessons (
  id uuid primary key default gen_random_uuid(),
  application_id uuid references fw_applications(id) on delete set null,
  date date,
  company text,
  role text,
  stage_reached text,
  stated_reason text,
  real_signal text,
  adjustment text,
  created_at timestamptz not null default now()
);

create table fw_drafts (
  id uuid primary key default gen_random_uuid(),
  application_id uuid references fw_applications(id) on delete cascade,
  contact_id uuid references fw_contacts(id) on delete cascade,
  type fw_draft_type not null,
  body text not null,
  status fw_draft_status not null default 'draft',
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create table fw_prep_docs (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references fw_applications(id) on delete cascade,
  round_type text,
  content text,
  debriefs jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- Fieldwork is single-user by design: one Supabase project per person. But
-- "any authenticated user has access" is not safe by default — if email
-- signups are ever enabled (they are, by default, on a new Supabase project),
-- a stranger who signs in with their own address would be an authenticated
-- user too, and a `using (true)` policy would hand them your whole pipeline.
--
-- So access is scoped to a single OWNER instead. The first person to sign in
-- claims the project (see fw_claim_owner below, called by the app on login);
-- every account after that is locked out at the database, regardless of the
-- Supabase signup setting. You get defense that does not depend on remembering
-- to flip a dashboard toggle. (Turning signups off is still good hygiene —
-- see the README security note — but it is no longer what protects your data.)
-- ---------------------------------------------------------------------------

-- Holds exactly one row: the uid that owns this project. The check constraint
-- + fixed primary key make a second row impossible, so ownership can be claimed
-- once and never reassigned by a later signup.
create table fw_owner (
  singleton boolean primary key default true,
  owner_uid uuid not null,
  claimed_at timestamptz not null default now(),
  constraint fw_owner_singleton check (singleton)
);
alter table fw_owner enable row level security;
-- No policies: fw_owner is reachable only through the security-definer functions
-- below, never read or written directly by a client.

-- The owning uid, or null before anyone has claimed. SECURITY DEFINER so the
-- RLS policies can consult it without each needing their own read of fw_owner.
-- search_path is pinned to defeat search-path hijacking (Supabase linter 0011).
create or replace function fw_owner_uid()
returns uuid
language sql
stable
security definer
set search_path = public
as $$ select owner_uid from fw_owner where singleton $$;

-- Claim ownership for the caller. Succeeds only when the project is unclaimed;
-- once a row exists, every later caller is a silent no-op and stays locked out.
-- Returns the owning uid either way. The app calls this right after sign-in.
create or replace function fw_claim_owner()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare current_owner uuid;
begin
  select owner_uid into current_owner from fw_owner where singleton;
  if current_owner is null and auth.uid() is not null then
    insert into fw_owner (owner_uid) values (auth.uid())
      on conflict (singleton) do nothing;
    select owner_uid into current_owner from fw_owner where singleton;
  end if;
  return current_owner;
end $$;

grant execute on function fw_owner_uid() to authenticated;
grant execute on function fw_claim_owner() to authenticated;

alter table fw_profile enable row level security;
alter table fw_settings enable row level security;
alter table fw_applications enable row level security;
alter table fw_jds enable row level security;
alter table fw_contacts enable row level security;
alter table fw_events enable row level security;
alter table fw_lessons enable row level security;
alter table fw_drafts enable row level security;
alter table fw_prep_docs enable row level security;
alter table fw_intake_runs enable row level security;
alter table fw_intake_run_items enable row level security;

-- Every table: readable and writable only by the owner. Before the project is
-- claimed fw_owner_uid() is null, so nothing matches and the tables are closed;
-- the first sign-in claims ownership and opens them for that one account.
create policy fw_owner_all on fw_profile      for all to authenticated using (auth.uid() = fw_owner_uid()) with check (auth.uid() = fw_owner_uid());
create policy fw_owner_all on fw_settings     for all to authenticated using (auth.uid() = fw_owner_uid()) with check (auth.uid() = fw_owner_uid());
create policy fw_owner_all on fw_applications for all to authenticated using (auth.uid() = fw_owner_uid()) with check (auth.uid() = fw_owner_uid());
create policy fw_owner_all on fw_jds          for all to authenticated using (auth.uid() = fw_owner_uid()) with check (auth.uid() = fw_owner_uid());
create policy fw_owner_all on fw_contacts     for all to authenticated using (auth.uid() = fw_owner_uid()) with check (auth.uid() = fw_owner_uid());
create policy fw_owner_all on fw_events       for all to authenticated using (auth.uid() = fw_owner_uid()) with check (auth.uid() = fw_owner_uid());
create policy fw_owner_all on fw_lessons      for all to authenticated using (auth.uid() = fw_owner_uid()) with check (auth.uid() = fw_owner_uid());
create policy fw_owner_all on fw_drafts       for all to authenticated using (auth.uid() = fw_owner_uid()) with check (auth.uid() = fw_owner_uid());
create policy fw_owner_all on fw_prep_docs    for all to authenticated using (auth.uid() = fw_owner_uid()) with check (auth.uid() = fw_owner_uid());
create policy fw_owner_all on fw_intake_runs  for all to authenticated using (auth.uid() = fw_owner_uid()) with check (auth.uid() = fw_owner_uid());
create policy fw_owner_all on fw_intake_run_items for all to authenticated using (auth.uid() = fw_owner_uid()) with check (auth.uid() = fw_owner_uid());

-- ---------------------------------------------------------------------------
-- Default settings
-- ---------------------------------------------------------------------------

insert into fw_settings (key, value) values
  -- ghost_days (not weeks): the silence threshold is a plain day count so values like 30 are
  -- expressible. Installs predating this key stored ghost_weeks; settings.ts still reads that
  -- as a fallback (ghost_weeks * 7) so an older row keeps working.
  ('timing', '{"nudge_days_min": 5, "nudge_days_max": 7, "ghost_days": 30, "thankyou_hours": 24}'::jsonb),
  ('theme',  '"dark"'::jsonb),
  ('whimsy', '"gentle"'::jsonb),
  ('models', '{"default": "claude-sonnet-5"}'::jsonb)
on conflict (key) do nothing;
