import { supabase } from './supabase';
import { isDateRange, isGroupBy, isSortMode, type DateRange, type GroupBy, type SortMode } from './insights';

export interface TimingSettings {
  nudge_days_min: number;
  nudge_days_max: number;
  /** Days of silence before an active application is auto-ghosted. Stored as a day count,
   * not weeks, so values like 30 are expressible — see getTimingSettings for how settings
   * rows written before this key existed (ghost_weeks) are still read. */
  ghost_days: number;
  thankyou_hours: number;
}

export type WhimsyLevel = 'off' | 'gentle' | 'full';

/** Hard fallback used ONLY if the `fw_settings` row is missing entirely (never happens in
 * normal operation — this is not a source of truth, just a last-resort so the UI doesn't
 * crash on an empty database). Real values always come from Supabase. */
const FALLBACK_TIMING: TimingSettings = {
  nudge_days_min: 5,
  nudge_days_max: 7,
  ghost_days: 30,
  thankyou_hours: 24,
};

/** Fetches every row from `fw_settings` as a key → value map. */
export async function getAllSettings(): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.from('fw_settings').select('key, value');
  if (error) throw error;
  const map: Record<string, unknown> = {};
  for (const row of (data ?? []) as { key: string; value: unknown }[]) {
    map[row.key] = row.value;
  }
  return map;
}

/** Raw `timing` jsonb, which may still carry the pre-ghost_days `ghost_weeks` key. */
type RawTiming = Partial<TimingSettings> & { ghost_weeks?: number };

export async function getTimingSettings(): Promise<TimingSettings> {
  const all = await getAllSettings();
  const timing = all.timing as RawTiming | undefined;

  // ghost_days is authoritative. Settings rows written before it existed only have
  // ghost_weeks — convert rather than silently snapping those installs to the 30-day
  // default, which would change their ghosting behaviour without asking.
  const ghostDays =
    timing?.ghost_days ??
    (typeof timing?.ghost_weeks === 'number' ? timing.ghost_weeks * 7 : undefined) ??
    FALLBACK_TIMING.ghost_days;

  return {
    nudge_days_min: timing?.nudge_days_min ?? FALLBACK_TIMING.nudge_days_min,
    nudge_days_max: timing?.nudge_days_max ?? FALLBACK_TIMING.nudge_days_max,
    ghost_days: ghostDays,
    thankyou_hours: timing?.thankyou_hours ?? FALLBACK_TIMING.thankyou_hours,
  };
}

export async function getWhimsyLevel(): Promise<WhimsyLevel> {
  const all = await getAllSettings();
  return (all.whimsy as WhimsyLevel | undefined) ?? 'gentle';
}

/** Board column order for the Pipeline. Reads `fw_settings.board_columns` if the key
 * exists; otherwise falls back to the `fw_status` enum order (still read from the type
 * definition, not a magic list re-typed at every call site). */
export async function getBoardColumns(fallback: string[]): Promise<string[]> {
  const all = await getAllSettings();
  const configured = all.board_columns as string[] | undefined;
  return configured && configured.length > 0 ? configured : fallback;
}

/** Per-column sort applied on the Pipeline board. 'default' preserves whatever order the
 * rows came back in (the board's original behavior before sorting existed). */
export type BoardSort = 'default' | 'newest' | 'oldest' | 'company' | 'active' | 'quiet';

const BOARD_SORTS: BoardSort[] = ['default', 'newest', 'oldest', 'company', 'active', 'quiet'];

export interface BoardPrefs {
  sort: BoardSort;
  hidden: string[];
  /** Bumped when a new column should be hidden for people who already have saved prefs —
   * see getBoardPrefs. Absent on anything written before the 'passed' column existed. */
  version?: number;
}

/** Current prefs version. v2 introduced the 'passed' column, which starts hidden: passing
 * on a role is meant to take it off the board, not park it in a column you stare at. */
const BOARD_PREFS_VERSION = 2;

export const DEFAULT_BOARD_PREFS: BoardPrefs = {
  sort: 'default',
  hidden: ['passed'],
  version: BOARD_PREFS_VERSION,
};

/** Pipeline board preferences, stored under `fw_settings.board_prefs` as
 * {"sort": "...", "hidden": ["phone_screen", ...], "version": 2}. Unknown or missing values
 * fall back to the defaults. Prefs saved before v2 get 'passed' hidden once, on read; after
 * that the stored value is authoritative, so unhiding Passed sticks. */
export async function getBoardPrefs(): Promise<BoardPrefs> {
  const all = await getAllSettings();
  const raw = all.board_prefs as Partial<BoardPrefs> | undefined;
  if (!raw) return { ...DEFAULT_BOARD_PREFS };

  const sort = BOARD_SORTS.includes(raw.sort as BoardSort) ? (raw.sort as BoardSort) : 'default';
  const hidden = Array.isArray(raw.hidden)
    ? raw.hidden.filter((v): v is string => typeof v === 'string')
    : [];
  if (raw.version !== BOARD_PREFS_VERSION && !hidden.includes('passed')) {
    hidden.push('passed');
  }
  return { sort, hidden, version: BOARD_PREFS_VERSION };
}

/** Raw persisted resume style: the new `resume_layout` + `resume_color` keys plus the
 * legacy pre-split `resume_template` key (kept readable for backward compat — users who
 * only ever saved the old combined id get it mapped to layout+color by
 * resolveResumeStyle in resumeDocx.ts). Values are raw strings (or null); callers
 * validate them against the known ids. */
export interface RawResumeStyleSettings {
  layout: string | null;
  color: string | null;
  legacyTemplate: string | null;
}

export async function getResumeStyleSettings(): Promise<RawResumeStyleSettings> {
  const all = await getAllSettings();
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    layout: str(all.resume_layout),
    color: str(all.resume_color),
    legacyTemplate: str(all.resume_template),
  };
}

export async function upsertSetting(key: string, value: unknown): Promise<void> {
  const { error } = await supabase.from('fw_settings').upsert({ key, value } as never);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Insights page preferences (panel order/visibility + sticky view controls)
// ---------------------------------------------------------------------------

/** Canonical panel ids in their default display order. The Insights view owns the labels and
 * renderers; this is just the ordering/visibility contract persisted to settings.
 *
 * Order is deliberate: 'intake' leads because what sourcing is finding is upstream of
 * everything below it, and 'lessons' anchors the bottom as the evidence for the rest. */
export const DEFAULT_INSIGHTS_ORDER = [
  'intake',
  'kpis',
  'funnel',
  'conversion',
  'breakdown',
  'deaths',
  'reasons',
  'titles',
  'velocity',
  'lessons',
] as const;

export type InsightsPanelId = (typeof DEFAULT_INSIGHTS_ORDER)[number];

export interface InsightsPrefs {
  /** Panel ids in display order (always covers every known panel). */
  order: InsightsPanelId[];
  /** Panel ids the user has hidden. */
  hidden: InsightsPanelId[];
  range: DateRange;
  groupBy: GroupBy;
  sort: SortMode;
  /** Rows to show on ranked bar charts; 0 = all. */
  topN: number;
}

export const DEFAULT_INSIGHTS_PREFS: InsightsPrefs = {
  order: [...DEFAULT_INSIGHTS_ORDER],
  hidden: [],
  range: 'all',
  groupBy: 'source',
  sort: 'count',
  topN: 10,
};

const KNOWN_PANELS = new Set<string>(DEFAULT_INSIGHTS_ORDER);

/** Insights prefs stored under `fw_settings.insights_prefs`. Unknown/missing values fall back
 * to defaults; any panel missing from a stored order (e.g. one added in a later release) is
 * appended so it still shows up. */
export async function getInsightsPrefs(): Promise<InsightsPrefs> {
  const all = await getAllSettings();
  const raw = all.insights_prefs as Partial<InsightsPrefs> | undefined;

  const storedOrder = Array.isArray(raw?.order)
    ? (raw!.order.filter((v) => typeof v === 'string' && KNOWN_PANELS.has(v)) as InsightsPanelId[])
    : [];
  const order = [...storedOrder];
  for (const id of DEFAULT_INSIGHTS_ORDER) if (!order.includes(id)) order.push(id);

  const hidden = Array.isArray(raw?.hidden)
    ? (raw!.hidden.filter((v) => typeof v === 'string' && KNOWN_PANELS.has(v)) as InsightsPanelId[])
    : [];

  return {
    order,
    hidden,
    range: isDateRange(raw?.range) ? raw!.range : DEFAULT_INSIGHTS_PREFS.range,
    groupBy: isGroupBy(raw?.groupBy) ? raw!.groupBy : DEFAULT_INSIGHTS_PREFS.groupBy,
    sort: isSortMode(raw?.sort) ? raw!.sort : DEFAULT_INSIGHTS_PREFS.sort,
    topN: typeof raw?.topN === 'number' && raw!.topN >= 0 ? raw!.topN : DEFAULT_INSIGHTS_PREFS.topN,
  };
}

export async function saveInsightsPrefs(prefs: InsightsPrefs): Promise<void> {
  await upsertSetting('insights_prefs', prefs);
}
