import { useEffect, useMemo, useState, useCallback } from 'react';
import { IconClose } from './icons';
import { supabase } from '../lib/supabase';
import {
  getBoardColumns,
  getBoardPrefs,
  upsertSetting,
  DEFAULT_BOARD_PREFS,
  type BoardPrefs,
  type BoardSort,
} from '../lib/settings';
import { setStatus, recordRejection, passApplication } from '../lib/applications';
import { STATUS_ORDER, STATUS_LABEL } from '../lib/pipeline';
import { agingLabel, parseDate } from '../lib/dateUtils';
import RejectionModal from './RejectionModal';
import type { FwApplication, FwEvent, FwStatus } from '../lib/types';

type LoadState = 'loading' | 'ready' | 'error';

const SORT_LABEL: Record<BoardSort, string> = {
  default: 'Default order',
  newest: 'Newest first',
  oldest: 'Oldest first',
  company: 'Company A-Z',
  active: 'Recently active',
  quiet: 'Longest quiet',
};

const SORT_OPTIONS: BoardSort[] = ['default', 'newest', 'oldest', 'company', 'active', 'quiet'];

/** Epoch ms for a stored date string, or a fallback when missing/unparseable. Uses the
 * LOCAL-date parser so bare YYYY-MM-DD values don't shift a day. */
function dateMs(iso: string | null | undefined, missing: number): number {
  if (!iso) return missing;
  const d = parseDate(iso);
  return Number.isNaN(d.getTime()) ? missing : d.getTime();
}

export default function PipelineBoard() {
  const [state, setState] = useState<LoadState>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [applications, setApplications] = useState<FwApplication[]>([]);
  const [lastEventByApp, setLastEventByApp] = useState<Record<string, string>>({});
  const [columns, setColumns] = useState<string[]>(STATUS_ORDER);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [dragId, setDragId] = useState<string | null>(null);
  const [pendingRejection, setPendingRejection] = useState<FwApplication | null>(null);
  const [prefs, setPrefs] = useState<BoardPrefs>(DEFAULT_BOARD_PREFS);
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);

  /** Updates board prefs in state and persists fire-and-forget — a failed save should
   * never block the board (same pattern as the whimsy toggle). */
  const updatePrefs = useCallback((next: BoardPrefs) => {
    setPrefs(next);
    upsertSetting('board_prefs', next).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const [appsRes, eventsRes, cols, storedPrefs] = await Promise.all([
        supabase.from('fw_applications').select('*'),
        supabase.from('fw_events').select('application_id, occurred_at'),
        getBoardColumns(STATUS_ORDER),
        getBoardPrefs().catch(() => DEFAULT_BOARD_PREFS),
      ]);
      if (appsRes.error) throw appsRes.error;
      if (eventsRes.error) throw eventsRes.error;

      const latest: Record<string, string> = {};
      for (const ev of (eventsRes.data ?? []) as Pick<FwEvent, 'application_id' | 'occurred_at'>[]) {
        const current = latest[ev.application_id];
        if (!current || new Date(ev.occurred_at) > new Date(current)) {
          latest[ev.application_id] = ev.occurred_at;
        }
      }

      setApplications((appsRes.data ?? []) as FwApplication[]);
      setLastEventByApp(latest);
      setColumns(cols);
      setPrefs(storedPrefs);
      setState('ready');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to load the pipeline.');
      setState('error');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return applications.filter((app) => {
      if (statusFilter !== 'all' && app.status !== statusFilter) return false;
      if (!q) return true;
      return (
        app.company.toLowerCase().includes(q) || (app.title ?? '').toLowerCase().includes(q)
      );
    });
  }, [applications, query, statusFilter]);

  const byColumn = useMemo(() => {
    const map = new Map<string, FwApplication[]>();
    for (const col of columns) map.set(col, []);
    for (const app of filtered) {
      const list = map.get(app.status) ?? [];
      list.push(app);
      map.set(app.status, list);
    }

    if (prefs.sort !== 'default') {
      // Same activity timestamp the aging badge uses: last event, then applied date, then
      // the row's own updated_at.
      const activity = (app: FwApplication) =>
        dateMs(lastEventByApp[app.id] ?? app.date_applied ?? app.updated_at, 0);
      const applied = (app: FwApplication, missing: number) =>
        dateMs(app.date_applied ?? app.created_at, missing);

      for (const list of map.values()) {
        list.sort((a, b) => {
          switch (prefs.sort) {
            case 'newest':
              return applied(b, 0) - applied(a, 0);
            case 'oldest':
              return applied(a, Number.MAX_SAFE_INTEGER) - applied(b, Number.MAX_SAFE_INTEGER);
            case 'company':
              return a.company.localeCompare(b.company);
            case 'active':
              return activity(b) - activity(a);
            case 'quiet':
              // Oldest activity first = been quiet the longest (aging desc).
              return activity(a) - activity(b);
            default:
              return 0;
          }
        });
      }
    }
    return map;
  }, [filtered, columns, prefs.sort, lastEventByApp]);

  const hiddenSet = useMemo(() => new Set(prefs.hidden), [prefs.hidden]);
  const visibleColumns = useMemo(
    () => columns.filter((col) => !hiddenSet.has(col)),
    [columns, hiddenSet],
  );
  const hiddenColumns = useMemo(
    () => columns.filter((col) => hiddenSet.has(col)),
    [columns, hiddenSet],
  );
  const hiddenCardCount = useMemo(
    () => hiddenColumns.reduce((sum, col) => sum + (byColumn.get(col) ?? []).length, 0),
    [hiddenColumns, byColumn],
  );

  function toggleColumn(col: string) {
    const hidden = hiddenSet.has(col)
      ? prefs.hidden.filter((c) => c !== col)
      : [...prefs.hidden, col];
    updatePrefs({ ...prefs, hidden });
  }

  function hideEmptyColumns() {
    const empty = columns.filter(
      (col) => (byColumn.get(col) ?? []).length === 0 && !hiddenSet.has(col),
    );
    if (empty.length === 0) return;
    updatePrefs({ ...prefs, hidden: [...prefs.hidden, ...empty] });
  }

  async function commitMove(app: FwApplication, newStatus: FwStatus) {
    if (newStatus === app.status) return;
    if (newStatus === 'rejected') {
      setPendingRejection(app);
      return;
    }
    try {
      await setStatus(app.id, newStatus, app.status);
      await load();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not move that card.');
    }
  }

  /** Pass on a to_apply role: it leaves the board (Passed is hidden by default) but the row
   * survives so sourcing runs won't recommend it again. Reversible — drag it back out of the
   * Passed column, which the Columns menu can unhide. */
  async function passOn(app: FwApplication) {
    try {
      await passApplication(app);
      await load();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not pass on that one.');
    }
  }

  async function confirmRejection(statedReason: string) {
    if (!pendingRejection) return;
    try {
      await recordRejection(pendingRejection, statedReason);
      setPendingRejection(null);
      await load();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not log the rejection.');
    }
  }

  if (state === 'loading') {
    return <p className="text-sm text-text-dim">Loading the pipeline…</p>;
  }

  if (state === 'error') {
    return (
      <div className="rounded-xl border border-danger/40 bg-surface p-6 text-sm text-danger">
        {errorMessage ?? 'Something went wrong loading the pipeline.'}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by company or title…"
          className="w-64 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
        >
          <option value="all">All statuses</option>
          {columns.map((col) => (
            <option key={col} value={col}>
              {STATUS_LABEL[col as FwStatus] ?? col}
            </option>
          ))}
        </select>
        <select
          value={prefs.sort}
          onChange={(e) => updatePrefs({ ...prefs, sort: e.target.value as BoardSort })}
          aria-label="Sort cards within columns"
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>
              Sort: {SORT_LABEL[opt]}
            </option>
          ))}
        </select>
        <div className="relative">
          <button
            type="button"
            onClick={() => setColumnsMenuOpen((open) => !open)}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none transition-colors hover:border-accent focus:border-accent"
          >
            Columns{hiddenColumns.length > 0 ? ` (${visibleColumns.length}/${columns.length})` : ''}
          </button>
          {columnsMenuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setColumnsMenuOpen(false)} />
              <div className="absolute left-0 top-full z-20 mt-2 w-56 rounded-xl border border-border bg-surface p-3 shadow-lg">
                <div className="flex flex-col gap-2">
                  {columns.map((col) => (
                    <label
                      key={col}
                      className="flex cursor-pointer items-center justify-between gap-2 text-sm text-text"
                    >
                      <span className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={!hiddenSet.has(col)}
                          onChange={() => toggleColumn(col)}
                          className="accent-accent"
                        />
                        {STATUS_LABEL[col as FwStatus] ?? col}
                      </span>
                      <span className="text-xs text-text-dim">
                        {(byColumn.get(col) ?? []).length}
                      </span>
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={hideEmptyColumns}
                  className="mt-3 w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-text-dim transition-colors hover:border-accent hover:text-text"
                >
                  Hide empty columns
                </button>
              </div>
            </>
          )}
        </div>
        {errorMessage && <p className="text-sm text-danger">{errorMessage}</p>}
      </div>

      {hiddenColumns.length > 0 && (
        <button
          type="button"
          onClick={() => updatePrefs({ ...prefs, hidden: [] })}
          className="self-start text-xs text-text-dim underline decoration-dotted underline-offset-2 transition-colors hover:text-text"
        >
          {hiddenColumns.length} {hiddenColumns.length === 1 ? 'column' : 'columns'} hidden (
          {hiddenCardCount} {hiddenCardCount === 1 ? 'card' : 'cards'}). Show all
        </button>
      )}

      <div className="flex flex-1 gap-4 overflow-x-auto pb-4">
        {visibleColumns.map((col) => (
          <div
            key={col}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const app = applications.find((a) => a.id === dragId);
              if (app) commitMove(app, col as FwStatus);
              setDragId(null);
            }}
            className="flex w-64 shrink-0 flex-col rounded-xl border border-border bg-surface/60 p-3"
          >
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium text-text">
                {STATUS_LABEL[col as FwStatus] ?? col}
              </p>
              <span className="text-xs text-text-dim">{(byColumn.get(col) ?? []).length}</span>
            </div>
            <div className="flex flex-1 flex-col gap-2">
              {(byColumn.get(col) ?? []).map((app) => (
                <div key={app.id} className="group relative">
                  <a
                    href={`/company?id=${app.id}`}
                    draggable
                    onDragStart={() => setDragId(app.id)}
                    onDragEnd={() => setDragId(null)}
                    className="block cursor-grab rounded-lg border border-border bg-surface p-3 text-left transition-colors hover:border-accent active:cursor-grabbing"
                  >
                    <p className="pr-6 text-sm font-medium text-text">{app.company}</p>
                    <p className="pr-6 text-xs text-text-dim">{app.title ?? '—'}</p>
                    <p className="mt-1 text-xs text-text-dim">
                      {agingLabel(lastEventByApp[app.id] ?? app.date_applied ?? app.updated_at)} old
                    </p>
                  </a>
                  {app.status === 'to_apply' && (
                    <button
                      type="button"
                      onClick={() => passOn(app)}
                      aria-label={`Pass on ${app.company}${app.title ? ` — ${app.title}` : ''}`}
                      title="Pass — takes it off the board and stops it being recommended again"
                      className="absolute right-1.5 top-1.5 rounded p-1 text-text-dim opacity-0 transition-opacity hover:bg-danger/10 hover:text-danger focus:opacity-100 group-hover:opacity-100"
                    >
                      <IconClose className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {pendingRejection && (
        <RejectionModal
          application={pendingRejection}
          onCancel={() => setPendingRejection(null)}
          onConfirm={confirmRejection}
        />
      )}
    </div>
  );
}
