import { supabase } from './supabase';
import { STATUS_ORDER, STATUS_LABEL } from './pipeline';
import { FW_GRADES } from './types';
import type { FwApplication, FwEvent, FwGrade, FwIntakeRun, FwLesson, FwStatus } from './types';

/** Everything the Insights page reads, in one round trip.
 *
 *  Four slices rather than three: `runs` powers the intake panels (what sourcing is
 *  actually finding), `events` powers the stage ladder (how far each application really
 *  got). Both were added independently and both are needed. */
export interface InsightsData {
  applications: FwApplication[];
  lessons: FwLesson[];
  runs: FwIntakeRun[];
  events: FwEvent[];
}

export async function loadInsightsData(): Promise<InsightsData> {
  const [appsRes, lessonsRes, runsRes, eventsRes] = await Promise.all([
    supabase.from('fw_applications').select('*'),
    supabase.from('fw_lessons').select('*').order('date', { ascending: true }),
    // ran_at ascending: summarizeIntake/buildRunRows treat the last element as the latest.
    supabase.from('fw_intake_runs').select('*').order('ran_at', { ascending: true }),
    supabase.from('fw_events').select('*'),
  ]);
  if (appsRes.error) throw appsRes.error;
  if (lessonsRes.error) throw lessonsRes.error;
  if (runsRes.error) throw runsRes.error;
  if (eventsRes.error) throw eventsRes.error;
  return {
    applications: (appsRes.data ?? []) as FwApplication[],
    lessons: (lessonsRes.data ?? []) as FwLesson[],
    runs: (runsRes.data ?? []) as FwIntakeRun[],
    events: (eventsRes.data ?? []) as FwEvent[],
  };
}

/** Grades at or above this rung are worth applying to. Anchored to the scorecard rubric,
 * where B is defined as "worth applying, with real caveats" and C as "a stretch" — so the
 * match line sits between B and C. Changing the rubric means revisiting this. */
const WORTH_APPLYING: FwGrade[] = ['A+', 'A', 'B'];

export interface IntakeSummary {
  runs: number;
  /** Distinct search queries issued across every sourcing run. */
  queriesRun: number;
  /** Roles the intake looked at, before any were dropped. */
  candidates: number;
  duplicates: number;
  expired: number;
  errors: number;
  scored: number;
  /** Graded at B or better. */
  matches: number;
  /** Share of *graded* roles worth applying to — not a share of candidates, since
   * duplicates and expired postings were never graded and would skew it down. */
  matchRate: number;
  lastRunAt: string | null;
}

export function summarizeIntake(runs: FwIntakeRun[]): IntakeSummary {
  const queries = new Set<string>();
  let candidates = 0, duplicates = 0, expired = 0, errors = 0, scored = 0, matches = 0;

  for (const run of runs) {
    for (const q of run.searched_queries ?? []) queries.add(q);
    candidates += run.candidates;
    duplicates += run.duplicates;
    expired += run.expired;
    errors += run.errors;
    scored += run.scored;
    for (const [grade, n] of Object.entries(run.grades ?? {})) {
      if (WORTH_APPLYING.includes(grade as FwGrade)) matches += n ?? 0;
    }
  }

  return {
    runs: runs.length,
    queriesRun: queries.size,
    candidates,
    duplicates,
    expired,
    errors,
    scored,
    matches,
    matchRate: scored ? matches / scored : 0,
    lastRunAt: runs.length ? runs[runs.length - 1].ran_at : null,
  };
}

export interface IntakeFunnelStage {
  label: string;
  count: number;
  note: string;
}

/** What happens to a role between "the search found it" and "it was worth applying to".
 * Each stage is a strict subset of the one above, so the drop-off is readable as a funnel. */
export function buildIntakeFunnel(s: IntakeSummary): IntakeFunnelStage[] {
  const live = s.candidates - s.duplicates - s.expired;
  return [
    { label: 'Found', count: s.candidates, note: 'roles the intake looked at' },
    { label: 'New & live', count: live, note: `${s.duplicates} already in pipeline, ${s.expired} expired` },
    { label: 'Graded', count: s.scored, note: s.errors ? `${s.errors} failed to score` : 'scored against your record' },
    { label: 'Worth applying', count: s.matches, note: 'graded B or better' },
  ];
}

export interface GradeSpread {
  grade: FwGrade;
  count: number;
}

/** Grade histogram across every run — the shape of what intake is actually surfacing.
 * Every rung is returned, including zeroes, so a distribution skewed to one end is
 * visible rather than hidden by absent bars. */
export function buildGradeSpread(runs: FwIntakeRun[]): GradeSpread[] {
  const counts = new Map<FwGrade, number>();
  for (const run of runs) {
    for (const [grade, n] of Object.entries(run.grades ?? {})) {
      counts.set(grade as FwGrade, (counts.get(grade as FwGrade) ?? 0) + (n ?? 0));
    }
  }
  return FW_GRADES.map((grade) => ({ grade, count: counts.get(grade) ?? 0 }));
}

export interface RunRow {
  id: string;
  ran_at: string;
  kind: FwRunKindLabel;
  candidates: number;
  scored: number;
  matches: number;
  dropped: number;
}

type FwRunKindLabel = 'Sourced from web' | 'Pasted batch' | 'Single scorecard';

const KIND_LABEL: Record<FwIntakeRun['kind'], FwRunKindLabel> = {
  daily_loop_source: 'Sourced from web',
  daily_loop_paste: 'Pasted batch',
  scorecard: 'Single scorecard',
};

/** Recent runs, newest first — the per-run detail behind the totals. */
export function buildRunRows(runs: FwIntakeRun[], limit = 10): RunRow[] {
  return [...runs]
    .sort((a, b) => (a.ran_at < b.ran_at ? 1 : -1))
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      ran_at: r.ran_at,
      kind: KIND_LABEL[r.kind],
      candidates: r.candidates,
      scored: r.scored,
      matches: Object.entries(r.grades ?? {}).reduce(
        (n, [g, c]) => (WORTH_APPLYING.includes(g as FwGrade) ? n + (c ?? 0) : n),
        0
      ),
      dropped: r.duplicates + r.expired + r.errors,
    }));
}

// ---------------------------------------------------------------------------
// Date-range filter (global control)
// ---------------------------------------------------------------------------

export type DateRange = '30d' | '90d' | '1y' | 'all';

export const DATE_RANGES: { id: DateRange; label: string }[] = [
  { id: '30d', label: 'Last 30 days' },
  { id: '90d', label: 'Last 90 days' },
  { id: '1y', label: 'Last 12 months' },
  { id: 'all', label: 'All time' },
];

export function isDateRange(v: unknown): v is DateRange {
  return v === '30d' || v === '90d' || v === '1y' || v === 'all';
}

/** The date an application "counts" on for time filtering: when it was applied, falling back
 * to when the row was created (so to_apply rows still land somewhere sensible). */
function appDate(app: FwApplication): Date | null {
  const raw = app.date_applied ?? app.created_at;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Filters applications to a trailing window. 'all' returns the list unchanged. Rows with no
 * usable date are kept only for 'all' (they can't be placed on a timeline otherwise). */
export function filterByDateRange(
  applications: FwApplication[],
  range: DateRange,
  now: Date = new Date()
): FwApplication[] {
  if (range === 'all') return applications;
  const days = range === '30d' ? 30 : range === '90d' ? 90 : 365;
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  return applications.filter((a) => {
    const d = appDate(a);
    return d != null && d.getTime() >= cutoff;
  });
}

/** Whether a single ISO date string falls inside the trailing window (for filtering lessons,
 * which carry their own date rather than an application's applied date). */
export function withinRange(
  dateStr: string | null | undefined,
  range: DateRange,
  now: Date = new Date()
): boolean {
  if (range === 'all') return true;
  if (!dateStr) return false;
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return false;
  const days = range === '30d' ? 30 : range === '90d' ? 90 : 365;
  return t >= now.getTime() - days * 24 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Furthest-stage reached (powers response/interview/offer rates + conversion)
// ---------------------------------------------------------------------------

/** The linear progression an application climbs. Terminal states (rejected/withdrawn/ghosted)
 * are NOT on the ladder — an app's furthest stage is the deepest rung it ever reached before
 * (or regardless of) a terminal outcome. */
export const STAGE_LADDER: FwStatus[] = [
  'applied',
  'phone_screen',
  'interviewing',
  'final_round',
  'offer',
  'accepted',
];

export const STAGE_LADDER_LABELS = STAGE_LADDER.map((s) => STATUS_LABEL[s]);

/** fw_events.type -> the ladder stage that event proves was reached. */
const EVENT_STAGE: Record<string, FwStatus> = {
  applied: 'applied',
  screen: 'phone_screen',
  round: 'interviewing',
  offer: 'offer',
};

function ladderIndex(status: string | null | undefined): number {
  if (!status) return -1;
  return STAGE_LADDER.indexOf(status as FwStatus);
}

/**
 * Maps a messy free-text stage note (fw_lessons.stage_reached is hand-written, e.g.
 * "interviewing (past the screen…)" or "recruiter call + CCAT assessment") onto a clean
 * ladder stage. Order matters: check the deepest keyword first. Returns null when nothing
 * matches (a truly unknown note).
 */
export function normalizeStageReached(raw: string | null | undefined): FwStatus | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (s.includes('offer') || s.includes('accepted')) return 'offer';
  if (s.includes('final')) return 'final_round';
  if (s.includes('interview') || s.includes('onsite') || s.includes('on-site') || s.includes('panel') || s.includes('loop')) {
    return 'interviewing';
  }
  if (
    s.includes('screen') ||
    s.includes('recruiter call') ||
    s.includes('phone') ||
    s.includes('assessment') ||
    s.includes('ccat') ||
    s.includes('hiring-manager') ||
    s.includes('hiring manager') ||
    s.includes('technical') ||
    s.includes('take-home') ||
    s.includes('take home')
  ) {
    return 'phone_screen';
  }
  if (s.includes('applied') || s.includes('application')) return 'applied';
  return null;
}

const TERMINAL = new Set<FwStatus>(['rejected', 'withdrawn', 'ghosted']);

/**
 * Furthest ladder rung each application reached, as an index into STAGE_LADDER (-1 = never
 * applied, i.e. still to_apply). Combines three signals, taking the deepest: current status,
 * any stage-implying fw_events, and fw_lessons.stage_reached recorded at rejection time. This
 * is the closest we get to true stage history without a dedicated stage-log table.
 */
export function computeReached(
  applications: FwApplication[],
  events: FwEvent[],
  lessons: FwLesson[]
): Map<string, number> {
  const eventsByApp = new Map<string, FwEvent[]>();
  for (const ev of events) {
    if (!ev.application_id) continue;
    const list = eventsByApp.get(ev.application_id) ?? [];
    list.push(ev);
    eventsByApp.set(ev.application_id, list);
  }
  const lessonByApp = new Map<string, FwLesson>();
  for (const l of lessons) {
    if (l.application_id && !lessonByApp.has(l.application_id)) lessonByApp.set(l.application_id, l);
  }

  const reached = new Map<string, number>();
  for (const app of applications) {
    // Base rung from status: a live ladder status maps directly; a terminal status means the
    // app at least applied (rung 0) unless deeper evidence exists below.
    let idx = ladderIndex(app.status);
    if (idx < 0 && TERMINAL.has(app.status)) idx = 0; // reached at least "applied"
    // to_apply stays -1.

    for (const ev of eventsByApp.get(app.id) ?? []) {
      const stage = EVENT_STAGE[ev.type];
      if (stage) idx = Math.max(idx, ladderIndex(stage));
    }
    const lesson = lessonByApp.get(app.id);
    const normalized = normalizeStageReached(lesson?.stage_reached);
    if (normalized) idx = Math.max(idx, STAGE_LADDER.indexOf(normalized));

    reached.set(app.id, idx);
  }
  return reached;
}

/** Earliest date an application drew a real response (a screen event or a status_change into
 * phone_screen or deeper), keyed by app id. Used for time-to-first-response. */
function firstResponseDates(events: FwEvent[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const ev of events) {
    if (!ev.application_id) continue;
    const isResponse = ev.type === 'screen' || ev.type === 'round' || ev.type === 'offer';
    if (!isResponse) continue;
    const t = new Date(ev.occurred_at).getTime();
    if (Number.isNaN(t)) continue;
    const cur = out.get(ev.application_id);
    if (cur == null || t < cur) out.set(ev.application_id, t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// KPI tiles
// ---------------------------------------------------------------------------

export interface Kpi {
  key: string;
  label: string;
  value: string;
  hint: string;
}

const pct = (num: number, denom: number): string =>
  denom === 0 ? '—' : `${Math.round((num / denom) * 100)}%`;

/** Headline rates over the "applied universe" (every application that got past to_apply). */
export function buildKpis(
  applications: FwApplication[],
  reached: Map<string, number>,
  events: FwEvent[]
): Kpi[] {
  const applied = applications.filter((a) => a.status !== 'to_apply');
  const total = applied.length;
  const r = (a: FwApplication) => reached.get(a.id) ?? -1;

  const responded = applied.filter((a) => r(a) >= 1).length; // phone_screen+
  const interviewed = applied.filter((a) => r(a) >= 2).length; // interviewing+
  const offered = applied.filter((a) => r(a) >= 4 || a.status === 'offer' || a.status === 'accepted').length;
  const ghosted = applied.filter((a) => a.status === 'ghosted').length;
  const active = applications.filter((a) =>
    (['applied', 'phone_screen', 'interviewing', 'final_round'] as FwStatus[]).includes(a.status)
  ).length;

  // Average days from applied date to first response, over apps that have both.
  const firstResp = firstResponseDates(events);
  const gaps: number[] = [];
  for (const a of applied) {
    const resp = firstResp.get(a.id);
    if (resp == null || !a.date_applied) continue;
    const applon = new Date(a.date_applied).getTime();
    if (Number.isNaN(applon)) continue;
    const days = (resp - applon) / (24 * 60 * 60 * 1000);
    if (days >= 0) gaps.push(days);
  }
  const avgDays = gaps.length ? Math.round(gaps.reduce((s, d) => s + d, 0) / gaps.length) : null;

  return [
    { key: 'applied', label: 'Applied', value: String(total), hint: 'Applications past To Apply in range' },
    { key: 'active', label: 'Active pipeline', value: String(active), hint: 'Live: applied through final round' },
    { key: 'response', label: 'Response rate', value: pct(responded, total), hint: `${responded} reached phone screen+` },
    { key: 'interview', label: 'Interview rate', value: pct(interviewed, total), hint: `${interviewed} reached interviewing+` },
    { key: 'offer', label: 'Offer rate', value: pct(offered, total), hint: `${offered} reached an offer` },
    { key: 'ghost', label: 'Ghost rate', value: pct(ghosted, total), hint: `${ghosted} went quiet` },
    {
      key: 'ttr',
      label: 'Avg days to reply',
      value: avgDays == null ? '—' : String(avgDays),
      hint: gaps.length ? `over ${gaps.length} with a dated reply` : 'no dated replies yet',
    },
  ];
}

// ---------------------------------------------------------------------------
// Stage conversion
// ---------------------------------------------------------------------------

export interface StageCount {
  stage: FwStatus;
  label: string;
  count: number;
}

export interface ConversionStep {
  fromLabel: string;
  toLabel: string;
  rate: number;
}

/** How many applications reached each ladder rung (reached>=i), plus the step-to-step
 * conversion between consecutive rungs — the "where does the pipeline leak" view. */
export function buildStageConversion(
  applications: FwApplication[],
  reached: Map<string, number>
): { counts: StageCount[]; steps: ConversionStep[] } {
  const counts: StageCount[] = STAGE_LADDER.map((stage, i) => ({
    stage,
    label: STATUS_LABEL[stage],
    count: applications.filter((a) => (reached.get(a.id) ?? -1) >= i).length,
  }));
  const steps: ConversionStep[] = [];
  for (let i = 1; i < counts.length; i++) {
    const prev = counts[i - 1].count;
    steps.push({
      fromLabel: counts[i - 1].label,
      toLabel: counts[i].label,
      rate: prev === 0 ? 0 : counts[i].count / prev,
    });
  }
  return { counts, steps };
}

// ---------------------------------------------------------------------------
// Generic rate breakdown (powers the group-by selector)
// ---------------------------------------------------------------------------

export type GroupBy = 'source' | 'title' | 'remote_type' | 'grade' | 'cover_letter';

export const GROUP_BYS: { id: GroupBy; label: string }[] = [
  { id: 'source', label: 'Source' },
  { id: 'title', label: 'Title' },
  { id: 'remote_type', label: 'Remote type' },
  { id: 'grade', label: 'Fit grade' },
  { id: 'cover_letter', label: 'Cover letter' },
];

export function isGroupBy(v: unknown): v is GroupBy {
  return GROUP_BYS.some((g) => g.id === v);
}

export type SortMode = 'count' | 'response' | 'win' | 'name';

export const SORT_MODES: { id: SortMode; label: string }[] = [
  { id: 'count', label: 'Volume' },
  { id: 'response', label: 'Response rate' },
  { id: 'win', label: 'Win rate' },
  { id: 'name', label: 'Name' },
];

export function isSortMode(v: unknown): v is SortMode {
  return SORT_MODES.some((s) => s.id === v);
}

export interface RateRow {
  key: string;
  label: string;
  total: number;
  responded: number;
  won: number;
  responseRate: number;
  winRate: number;
}

function groupKey(app: FwApplication, groupBy: GroupBy): { key: string; label: string } {
  switch (groupBy) {
    case 'source': {
      const s = (app.source ?? '').trim();
      return { key: s ? s.toLowerCase() : '—', label: s || 'Unknown' };
    }
    case 'title': {
      const t = (app.title ?? '').trim();
      return { key: t ? t.toLowerCase() : '—', label: t || 'Untitled role' };
    }
    case 'remote_type': {
      const rt = (app.remote_type ?? '').trim();
      return { key: rt ? rt.toLowerCase() : '—', label: rt ? rt[0].toUpperCase() + rt.slice(1) : 'Unknown' };
    }
    /* The private repo grouped by a 4-value `verdict`; this repo scores roles with a
       letter `grade` instead, which is already human-readable, so no label map. */
    case 'grade': {
      const g = app.grade ?? '';
      return { key: g || '—', label: g || 'Not scored' };
    }
    case 'cover_letter':
      return app.cover_letter
        ? { key: 'yes', label: 'With cover letter' }
        : { key: 'no', label: 'No cover letter' };
  }
}

const WIN = new Set<FwStatus>(['offer', 'accepted']);

/**
 * Response and win rates grouped by an arbitrary application attribute. The applied universe
 * only (status past to_apply). Sorting and top-N are applied here so every consumer (and the
 * print/test paths) rank identically.
 */
export function buildRateBreakdown(
  applications: FwApplication[],
  reached: Map<string, number>,
  groupBy: GroupBy,
  opts: { sort: SortMode; topN: number }
): RateRow[] {
  const groups = new Map<string, RateRow>();
  for (const app of applications) {
    if (app.status === 'to_apply') continue;
    const { key, label } = groupKey(app, groupBy);
    const row = groups.get(key) ?? {
      key,
      label,
      total: 0,
      responded: 0,
      won: 0,
      responseRate: 0,
      winRate: 0,
    };
    row.total += 1;
    if ((reached.get(app.id) ?? -1) >= 1) row.responded += 1;
    if (WIN.has(app.status)) row.won += 1;
    groups.set(key, row);
  }

  const rows = Array.from(groups.values()).map((r) => ({
    ...r,
    responseRate: r.total ? r.responded / r.total : 0,
    winRate: r.total ? r.won / r.total : 0,
  }));

  rows.sort((a, b) => {
    switch (opts.sort) {
      case 'name':
        return a.label.localeCompare(b.label);
      case 'response':
        return b.responseRate - a.responseRate || b.total - a.total;
      case 'win':
        return b.winRate - a.winRate || b.total - a.total;
      case 'count':
      default:
        return b.total - a.total || b.responseRate - a.responseRate;
    }
  });

  return opts.topN > 0 ? rows.slice(0, opts.topN) : rows;
}

export interface FunnelStage {
  status: FwStatus;
  label: string;
  count: number;
}

/** Counts applications currently sitting at each fw_status value, in enum order. This is a
 * snapshot funnel (current distribution), not a strict "reached this stage" cohort funnel —
 * true stage-reached tracking would need per-application stage history the schema doesn't
 * capture beyond fw_events, which isn't uniformly populated across all 151 imported rows. */
export function buildFunnel(applications: FwApplication[]): FunnelStage[] {
  const counts = new Map<string, number>();
  for (const app of applications) {
    counts.set(app.status, (counts.get(app.status) ?? 0) + 1);
  }
  return STATUS_ORDER.map((status) => ({
    status,
    label: STATUS_LABEL[status],
    count: counts.get(status) ?? 0,
  }));
}

export interface DeathStage {
  stage: string;
  count: number;
}

/** Where rejections concentrate, by the stage the application had reached right before it
 * was rejected (fw_lessons.stage_reached, written by recordRejection() at the moment of the
 * Pipeline drag-to-reject). Ghosted/withdrawn applications don't get a lessons row today, so
 * they're reported as their own totals alongside rather than folded into "stage reached". */
export function buildDeathsByStage(
  applications: FwApplication[],
  lessons: FwLesson[]
): { stages: DeathStage[]; ghosted: number; withdrawn: number } {
  const counts = new Map<string, number>();
  for (const lesson of lessons) {
    const normalized = normalizeStageReached(lesson.stage_reached);
    const label = normalized ? STATUS_LABEL[normalized] : 'Unknown';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const stages = Array.from(counts.entries())
    .map(([stage, count]) => ({ stage, count }))
    .sort((a, b) => b.count - a.count);

  return {
    stages,
    ghosted: applications.filter((a) => a.status === 'ghosted').length,
    withdrawn: applications.filter((a) => a.status === 'withdrawn').length,
  };
}

export interface ReasonBucket {
  bucket: string;
  count: number;
}

const REASON_KEYWORDS: [string, string[]][] = [
  ['Internal / other candidate', ['internal candidate', 'internal hire', 'went with someone', 'another candidate']],
  ['Comp mismatch', ['comp', 'salary', 'budget', 'compensation', 'pay range']],
  ['Overqualified / seniority mismatch', ['overqualified', 'too senior', 'too junior', 'seniority', 'not senior enough']],
  ['Skills / experience gap', ['skills gap', 'experience', 'did not have', "didn't have", 'lacked', 'missing']],
  ['Role paused / timing', ['paused', 'put the role on hold', 'timing', 'position was closed', 'role was cancelled', 'on hold']],
  ['Culture / team fit', ['culture fit', 'team fit', 'not the right fit', "wasn't the right fit"]],
  ['No reason given', ['', 'no reason', 'none given', 'did not say', "didn't say"]],
];

/** Rough keyword clustering over fw_lessons.stated_reason (plus real_signal/adjustment when
 * populated) — deliberately simple per the task brief ("doesn't need ML"). Anything that
 * doesn't match a bucket's keywords, and isn't blank, falls into "Other". */
export function clusterRejectionReasons(lessons: FwLesson[]): ReasonBucket[] {
  const counts = new Map<string, number>();
  for (const lesson of lessons) {
    const combined = [lesson.stated_reason, lesson.real_signal, lesson.adjustment]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .trim();

    if (!combined) {
      counts.set('No reason given', (counts.get('No reason given') ?? 0) + 1);
      continue;
    }

    let matched = false;
    for (const [bucket, keywords] of REASON_KEYWORDS) {
      if (bucket === 'No reason given') continue;
      if (keywords.some((k) => k && combined.includes(k))) {
        counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
        matched = true;
        break;
      }
    }
    if (!matched) counts.set('Other', (counts.get('Other') ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([bucket, count]) => ({ bucket, count }))
    .sort((a, b) => b.count - a.count);
}

export interface TitleWinRate {
  title: string;
  total: number;
  wins: number;
  rate: number;
}

const TERMINAL_STATUSES = new Set<FwStatus>(['offer', 'accepted', 'rejected', 'withdrawn', 'ghosted']);
const WIN_STATUSES = new Set<FwStatus>(['offer', 'accepted']);

/** Win-rate per title, counted only over applications that have reached a terminal outcome
 * (still-open roles would understate the rate). Titles are used as typed on the
 * application — no normalization beyond trim/case-fold, since that's what the real data
 * supports without inventing a taxonomy. */
export function buildTitleWinRates(applications: FwApplication[]): TitleWinRate[] {
  const byTitle = new Map<string, { total: number; wins: number; display: string }>();
  for (const app of applications) {
    if (!TERMINAL_STATUSES.has(app.status)) continue;
    const raw = (app.title ?? 'Untitled role').trim();
    const key = raw.toLowerCase();
    const entry = byTitle.get(key) ?? { total: 0, wins: 0, display: raw };
    entry.total += 1;
    if (WIN_STATUSES.has(app.status)) entry.wins += 1;
    byTitle.set(key, entry);
  }
  return Array.from(byTitle.values())
    .map((e) => ({ title: e.display, total: e.total, wins: e.wins, rate: e.total ? e.wins / e.total : 0 }))
    .sort((a, b) => b.total - a.total);
}

export interface WeeklyVelocity {
  weekStart: string;
  count: number;
}

/** Applications submitted per ISO week (Monday start), from date_applied. Only rows with a
 * date_applied are counted — to_apply rows with no applied date yet don't appear until they
 * move. */
export function buildWeeklyVelocity(applications: FwApplication[]): WeeklyVelocity[] {
  const counts = new Map<string, number>();
  for (const app of applications) {
    if (!app.date_applied) continue;
    const d = new Date(app.date_applied);
    if (Number.isNaN(d.getTime())) continue;
    const day = d.getUTCDay();
    const diffToMonday = (day + 6) % 7;
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diffToMonday));
    const key = monday.toISOString().slice(0, 10);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([weekStart, count]) => ({ weekStart, count }))
    .sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1));
}
