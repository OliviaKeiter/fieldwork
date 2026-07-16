import { supabase } from './supabase';
import { invokeFn } from './functions';
import type { FwGrade, FwIntakeRun, FwIntakeRunItem } from './types';

/** Shape returned by the `scorecard` edge function (and, per-candidate, by `daily_loop`). */
export interface VerdictCard {
  grade: FwGrade;
  comp_min: number | null;
  comp_max: number | null;
  remote_type: string | null;
  location: string | null;
  pain_line: string | null;
  gaps: string[];
  reasoning: string;
  jd_text: string;
  live_checked_at: string | null;
  liveness_note: string | null;
}

export interface DailyLoopCandidateInput {
  company: string;
  title?: string;
  jd_text?: string;
  url?: string;
}

/** One row of the `daily_loop` response. Duplicates, provably-expired postings, and scoring
 * failures all come back without full grade fields — check `duplicate`, `expired` and
 * `error` before reading them. */
export interface DailyLoopResult extends Partial<VerdictCard> {
  company: string;
  title: string | null;
  url: string | null;
  duplicate: boolean;
  /** Skipped before scoring: a 404/410, or a schema.org validThrough already past. */
  expired?: boolean;
  error?: string;
}

/** company/title play no part in scoring — they ride along so the run this logs is stored as
 * a complete, re-filable card instead of one labelled "(unknown)". */
export async function runScorecard(input: {
  jd_text?: string;
  url?: string;
  company?: string;
  title?: string;
}): Promise<VerdictCard> {
  return invokeFn<VerdictCard>('scorecard', input);
}

/** The most recent intake run and the roles it looked at, newest first.
 *
 * This is what makes a bad run recoverable: the cards are read back from
 * fw_intake_run_items rather than re-scored, so a failed render costs nothing but a click.
 * Returns null when nothing has been logged yet. */
export async function loadLastRun(): Promise<{ run: FwIntakeRun; items: FwIntakeRunItem[] } | null> {
  const { data: runs, error: runErr } = await supabase
    .from('fw_intake_runs')
    .select('*')
    .order('ran_at', { ascending: false })
    .limit(1);
  if (runErr) throw runErr;
  const run = (runs ?? [])[0] as FwIntakeRun | undefined;
  if (!run) return null;

  const { data: items, error: itemErr } = await supabase
    .from('fw_intake_run_items')
    .select('*')
    .eq('run_id', run.id)
    .order('created_at', { ascending: true });
  if (itemErr) throw itemErr;
  return { run, items: (items ?? []) as FwIntakeRunItem[] };
}

/** Re-shapes a stored item back into the same result row the edge function returns, so a
 * reopened run renders through exactly the same card path as a live one — no second
 * rendering branch to drift out of sync. */
export function itemToResult(item: FwIntakeRunItem): DailyLoopResult {
  return {
    company: item.company,
    title: item.title,
    url: item.url,
    duplicate: item.outcome === 'duplicate',
    expired: item.outcome === 'expired',
    error: item.error ?? undefined,
    grade: item.grade ?? undefined,
    comp_min: item.comp_min,
    comp_max: item.comp_max,
    remote_type: item.remote_type,
    location: item.location,
    pain_line: item.pain_line,
    gaps: item.gaps ?? [],
    reasoning: item.reasoning ?? '',
    jd_text: item.jd_text ?? '',
    live_checked_at: item.live_checked_at,
    liveness_note: item.liveness_note,
  };
}

export async function runDailyLoop(candidates: DailyLoopCandidateInput[]): Promise<DailyLoopResult[]> {
  const res = await invokeFn<{ results: DailyLoopResult[] }>('daily_loop', { candidates });
  return res.results;
}

/** Autonomous sourcing mode: the edge function searches the web (Tavily) for live roles
 * matching the profile's target titles, triages, dedupes, and scores them. Requires the
 * TAVILY_API_KEY Supabase secret; the function returns a clear error naming it if unset. */
export async function runSourcedDailyLoop(count = 10): Promise<DailyLoopResult[]> {
  const res = await invokeFn<{ results: DailyLoopResult[] }>('daily_loop', { source: true, count });
  return res.results;
}

/** Records a discarded candidate as a `passed` row so it stops coming back. daily_loop
 * dedupes sourced candidates against fw_applications by company+title with no status
 * filter, so this row is the only thing that suppresses a re-recommend — a purely
 * client-side discard leaves the posting free to resurface on the next sourcing run.
 * Deliberately writes no fw_jds row: a pass isn't worth keeping the JD text for. */
export async function recordPass(params: {
  company: string;
  title: string | null;
  grade?: FwGrade | null;
  source?: string;
}): Promise<void> {
  const { error } = await supabase.from('fw_applications').insert({
    company: params.company,
    title: params.title,
    status: 'passed',
    grade: params.grade ?? null,
    source: params.source ?? 'intake',
    notes: 'Passed at intake — discarded from a scorecard.',
  } as never);
  if (error) throw error;
}

/** Files a reviewed verdict card as a new `to_apply` application + its JD row. Used by both
 * the single-scorecard flow and each daily-loop card once the user reviews and accepts it —
 * nothing is written to the pipeline until this is explicitly called from a click. */
export async function fileAsToApply(params: {
  company: string;
  title: string | null;
  card: Pick<
    VerdictCard,
    'grade' | 'comp_min' | 'comp_max' | 'remote_type' | 'pain_line' | 'gaps' | 'jd_text' | 'live_checked_at'
  >;
  url?: string | null;
  source?: string;
}): Promise<void> {
  const { company, title, card, url, source } = params;

  const { data: app, error: appErr } = await supabase
    .from('fw_applications')
    .insert({
      company,
      title,
      status: 'to_apply',
      grade: card.grade,
      comp_min: card.comp_min,
      comp_max: card.comp_max,
      remote_type: card.remote_type,
      source: source ?? 'intake',
    } as never)
    .select()
    .single();
  if (appErr) throw appErr;

  const { error: jdErr } = await supabase.from('fw_jds').insert({
    application_id: (app as { id: string }).id,
    url: url ?? null,
    raw_text: card.jd_text,
    pain_line: card.pain_line,
    gaps: card.gaps,
    live_checked_at: card.live_checked_at,
    source: source ?? 'intake',
  } as never);
  if (jdErr) throw jdErr;
}
