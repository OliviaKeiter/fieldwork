import { supabase } from './supabase';
import { invokeFn } from './functions';
import { FW_GRADES } from './types';
import type { FwGrade, FwIntakeRunItem, FwStatus } from './types';

/** Shape returned by the `scorecard` edge function (and, per-candidate, by `daily_loop`). */
export interface VerdictCard {
  grade: FwGrade;
  /** Extracted from the JD by the model when the user left the intake fields blank
   * (user-typed values win server-side). Optional: daily_loop rows carry these at the
   * top level instead. */
  company?: string | null;
  title?: string | null;
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

/** Identity key for cards within a list (React keys, removal after filing). Exact
 * company+title, case-insensitive. For dedupe against the pipeline use matchKeys — this
 * one is deliberately strict so two distinct cards never collapse mid-session. */
export function pendingKey(company: string, title: string | null | undefined): string {
  return `${company.trim().toLowerCase()}::${(title ?? '').trim().toLowerCase()}`;
}

function normToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** All keys under which a company+title pair counts as "the same role" — the dedupe every
 * part of the system agrees on, mirrored verbatim in daily_loop's server-side skip.
 *
 * The scoring model extracts the company name slightly differently run to run ("Precision
 * AQ", "PrecisionAQ / Precision Medicine Group", "Precision AQ (Precision Medicine
 * Group)"), and an exact string match waves every variant through as a "new" role. So
 * alongside the full normalized name, each slash/paren-delimited segment gets its own key.
 * Titles still match exactly (normalized) — the segment keys only collide when the title
 * matches too, which keeps false positives rare. Deliberately NOT split on hyphens or
 * commas: "Coca-Cola" and "G-P" are one name, not two. */
export function matchKeys(company: string, title: string | null | undefined): string[] {
  const t = normToken(title ?? '');
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
 * all of those are one role. Mirrored verbatim in daily_loop. */
export function normalizeJobUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const parsed = new URL(u);
    return (parsed.host.replace(/^www\./, '') + parsed.pathname.replace(/\/+$/, '')).toLowerCase();
  } catch {
    return null;
  }
}

/** Every graded card not yet filed or passed on — the persistent review queue.
 *
 * Both the scorecard and daily_loop functions log each graded card to
 * fw_intake_run_items, and filing/discarding writes an fw_applications row (to_apply or
 * passed). So "graded item with no matching application" is precisely "card the user has
 * not dealt with yet", across page reloads, with no extra bookkeeping to get wrong.
 * Deduped by company-variant+title keys AND by canonical posting URL (a role re-scored in
 * a later run — or re-extracted under a slightly different company name — shows once,
 * newest grade), sorted best grade first. Capped at the 200 newest graded items — beyond
 * that a card is stale enough that re-scoring it is more honest than reviewing it. */
export async function loadPendingCards(): Promise<DailyLoopResult[]> {
  const [itemsRes, appsRes, jdsRes] = await Promise.all([
    supabase
      .from('fw_intake_run_items')
      .select('*')
      .eq('outcome', 'graded')
      .order('created_at', { ascending: false })
      .limit(200),
    supabase.from('fw_applications').select('company, title'),
    supabase.from('fw_jds').select('url'),
  ]);
  if (itemsRes.error) throw itemsRes.error;
  if (appsRes.error) throw appsRes.error;
  if (jdsRes.error) throw jdsRes.error;

  const existing = new Set<string>();
  for (const a of (appsRes.data ?? []) as { company: string; title: string | null }[]) {
    for (const k of matchKeys(a.company, a.title)) existing.add(k);
  }
  const existingUrls = new Set(
    ((jdsRes.data ?? []) as { url: string | null }[])
      .map((j) => normalizeJobUrl(j.url))
      .filter((u): u is string => u !== null)
  );
  const seen = new Set<string>();
  const pending: FwIntakeRunItem[] = [];
  for (const item of (itemsRes.data ?? []) as FwIntakeRunItem[]) {
    const keys = matchKeys(item.company, item.title);
    if (keys.some((k) => existing.has(k) || seen.has(k))) continue;
    const urlKey = normalizeJobUrl(item.url);
    if (urlKey && existingUrls.has(urlKey)) continue;
    for (const k of keys) seen.add(k);
    pending.push(item);
  }
  // Stable sort: items arrive newest-first, so within a grade the newest card stays on top.
  pending.sort(
    (a, b) =>
      FW_GRADES.indexOf(a.grade ?? 'F') - FW_GRADES.indexOf(b.grade ?? 'F')
  );
  return pending.map(itemToResult);
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

/** A duplicate row from a run, joined to the pipeline row that blocked it. */
export interface DuplicateMatch extends DailyLoopResult {
  application_id: string | null;
  application_status: FwStatus | null;
}

/** Resolves each duplicate a run reported to the fw_applications row it collided with,
 * using the same company-variant+title keys the edge function dedupes on — so "skipped as
 * duplicate" can render as a real link to the dossier instead of a bare count. A row that
 * can't be matched (renamed since the run, say) comes back with null ids and renders
 * without the link. */
export async function resolveDuplicates(dupes: DailyLoopResult[]): Promise<DuplicateMatch[]> {
  if (dupes.length === 0) return [];
  const { data, error } = await supabase
    .from('fw_applications')
    .select('id, company, title, status');
  if (error) throw error;
  const byKey = new Map<string, { id: string; company: string; title: string | null; status: FwStatus }>();
  for (const a of (data ?? []) as { id: string; company: string; title: string | null; status: FwStatus }[]) {
    for (const k of matchKeys(a.company, a.title)) {
      if (!byKey.has(k)) byKey.set(k, a);
    }
  }
  return dupes.map((d) => {
    const match = matchKeys(d.company, d.title)
      .map((k) => byKey.get(k))
      .find((a) => a !== undefined);
    return {
      ...d,
      application_id: match?.id ?? null,
      application_status: match?.status ?? null,
    };
  });
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
