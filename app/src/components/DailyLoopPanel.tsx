import { useEffect, useState, type FormEvent } from 'react';
import { IconChevronDown } from './icons';
import {
  fileAsToApply,
  loadPendingCards,
  pendingKey,
  recordPass,
  runDailyLoop,
  runSourcedDailyLoop,
  type DailyLoopCandidateInput,
  type DailyLoopResult,
} from '../lib/intake';
import VerdictCardView from './VerdictCardView';
import BuildProgress from './BuildProgress';

interface CandidateRow {
  company: string;
  title: string;
  jd_text: string;
  url: string;
}

const EMPTY_ROW: CandidateRow = { company: '', title: '', jd_text: '', url: '' };

type RunState = 'idle' | 'loading' | 'ready' | 'error';
type CardBusy = 'filing' | 'discarding';

/** How many postings one sourcing run should try to bring back. The daily_loop function
 * clamps to 20, so don't offer more than it will honor. */
const SOURCE_COUNTS = [10, 15, 20];

/** Two flows, two honest stage lists. Sourcing searches the web, triages, dedupes against
 * the pipeline, then grades what survives; the paste flow skips straight to grading. Both
 * take long enough that a bare disabled button reads as a hang. */
const SOURCE_STAGES = [
  'Searching for live postings…',
  'Triaging what came back…',
  'Skipping anything already in your pipeline…',
  'Grading each role…',
];

const SCORE_STAGES = [
  'Reading your career record…',
  'Checking the postings are still live…',
  'Grading each role…',
];

/** One sentence for everything a run looked at but produced no card for. Skipped roles
 * (already applied to or passed on) and provably-closed postings get counted, not listed —
 * a card per non-option is noise the user asked to be rid of. */
function summarize(scored: DailyLoopResult[]): string | null {
  const graded = scored.filter((r) => !r.duplicate && !r.expired && !r.error && r.grade).length;
  const dupes = scored.filter((r) => r.duplicate).length;
  const expired = scored.filter((r) => r.expired).length;
  const parts: string[] = [];
  if (graded > 0) parts.push(`Scored ${graded} new role${graded === 1 ? '' : 's'}.`);
  const skips: string[] = [];
  if (dupes > 0) skips.push(`${dupes} already in your pipeline or passed on`);
  if (expired > 0) skips.push(`${expired} closed posting${expired === 1 ? '' : 's'}`);
  if (skips.length > 0) parts.push(`Skipped ${skips.join(' and ')}.`);
  return parts.length > 0 ? parts.join(' ') : null;
}

/** [Run daily loop]: source roles from the web (or paste a batch), score them all in one
 * call, then review each resulting card and file or discard it individually. The daily_loop
 * edge function deliberately does not write anything itself — see its file header — so every
 * write here is a direct result of a click on a card the user reviewed.
 *
 * Graded cards live in a persistent review queue: every run's graded items are logged to
 * fw_intake_run_items, and a card stays in the queue — across reloads — until filing or
 * discarding writes the fw_applications row that clears it (see loadPendingCards). */
export default function DailyLoopPanel() {
  const [pending, setPending] = useState<DailyLoopResult[]>([]);
  const [pendingNote, setPendingNote] = useState<string | null>(null);

  const [pasteOpen, setPasteOpen] = useState(false);
  const [rows, setRows] = useState<CandidateRow[]>([{ ...EMPTY_ROW }]);
  const [runState, setRunState] = useState<RunState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  /** One line of counts from the last run (scored / skipped / closed). */
  const [runSummary, setRunSummary] = useState<string | null>(null);
  /** Per-candidate failures from the last run — these still get their own rows. */
  const [runErrors, setRunErrors] = useState<DailyLoopResult[]>([]);
  const [cardBusy, setCardBusy] = useState<Record<string, CardBusy>>({});
  const [cardError, setCardError] = useState<Record<string, string>>({});
  const [sourceCount, setSourceCount] = useState(10);
  const [runDone, setRunDone] = useState(false);
  /** Which flow is in flight — picks the stage list the bar narrates. */
  const [runKind, setRunKind] = useState<'source' | 'score'>('score');

  // The review queue survives reloads: anything graded but never filed or discarded —
  // from any previous daily loop OR single scorecard run — comes back up for review.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cards = await loadPendingCards();
        if (!cancelled) setPending(cards);
      } catch (err) {
        if (!cancelled) {
          setPendingNote(
            'Could not load cards waiting for review' +
              (err instanceof Error ? ` — ${err.message}` : '.')
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Fresh graded cards go to the top of the queue; a re-scored role replaces its older
   * card instead of sitting next to it. */
  function mergeIntoQueue(scored: DailyLoopResult[]) {
    const fresh: DailyLoopResult[] = [];
    const freshKeys = new Set<string>();
    for (const r of scored) {
      if (r.duplicate || r.expired || r.error || !r.grade) continue;
      const key = pendingKey(r.company, r.title);
      if (freshKeys.has(key)) continue;
      freshKeys.add(key);
      fresh.push(r);
    }
    setPending((prev) => [
      ...fresh,
      ...prev.filter((r) => !freshKeys.has(pendingKey(r.company, r.title))),
    ]);
  }

  function updateRow(i: number, patch: Partial<CandidateRow>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  function addRow() {
    setRows((prev) => [...prev, { ...EMPTY_ROW }]);
  }

  function removeRow(i: number) {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
  }

  function startRun(kind: 'source' | 'score') {
    setRunState('loading');
    setRunKind(kind);
    setRunDone(false);
    setErrorMessage(null);
    setRunSummary(null);
    setRunErrors([]);
  }

  function finishRun(scored: DailyLoopResult[]) {
    mergeIntoQueue(scored);
    setRunSummary(summarize(scored));
    setRunErrors(scored.filter((r) => !r.duplicate && !r.expired && (r.error || !r.grade)));
    setRunState('ready');
  }

  async function handleSourceRun() {
    startRun('source');
    try {
      const scored = await runSourcedDailyLoop(sourceCount);
      setRunDone(true);
      await new Promise((resolve) => setTimeout(resolve, 450));
      if (scored.length === 0) {
        setErrorMessage('The web search came back empty this run — try again later or paste candidates instead.');
        setRunState('error');
        return;
      }
      finishRun(scored);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Sourcing failed.');
      setRunState('error');
    }
  }

  async function handlePasteRun(e: FormEvent) {
    e.preventDefault();
    const candidates: DailyLoopCandidateInput[] = rows
      .filter((r) => r.company.trim() && (r.jd_text.trim() || r.url.trim()))
      .map((r) => ({
        company: r.company.trim(),
        title: r.title.trim() || undefined,
        jd_text: r.jd_text.trim() || undefined,
        url: r.url.trim() || undefined,
      }));

    if (candidates.length === 0) {
      setErrorMessage('Add at least one candidate with a company and either JD text or a URL.');
      setRunState('error');
      return;
    }

    startRun('score');
    try {
      const scored = await runDailyLoop(candidates);
      setRunDone(true);
      await new Promise((resolve) => setTimeout(resolve, 450));
      finishRun(scored);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Daily loop failed.');
      setRunState('error');
    }
  }

  function setBusy(key: string, busy: CardBusy | null) {
    setCardBusy((prev) => {
      const next = { ...prev };
      if (busy) next[key] = busy;
      else delete next[key];
      return next;
    });
  }

  function clearCard(key: string) {
    setPending((prev) => prev.filter((r) => pendingKey(r.company, r.title) !== key));
    setBusy(key, null);
    setCardError((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  async function handleFile(result: DailyLoopResult) {
    if (!result.grade) return;
    const key = pendingKey(result.company, result.title);
    setBusy(key, 'filing');
    setCardError((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    try {
      await fileAsToApply({
        company: result.company,
        title: result.title,
        card: {
          grade: result.grade,
          comp_min: result.comp_min ?? null,
          comp_max: result.comp_max ?? null,
          remote_type: result.remote_type ?? null,
          pain_line: result.pain_line ?? null,
          gaps: result.gaps ?? [],
          jd_text: result.jd_text ?? '',
          live_checked_at: result.live_checked_at ?? null,
        },
        url: result.url,
        source: 'daily_loop',
      });
      // The fw_applications row now exists, which is what "reviewed" means here — the card
      // has done its job and leaves the queue.
      clearCard(key);
    } catch (err) {
      setCardError((prev) => ({
        ...prev,
        [key]: err instanceof Error ? err.message : 'Could not file this one.',
      }));
      setBusy(key, null);
    }
  }

  /** Discarding writes a `passed` row rather than just dropping the card. Both the sourcing
   * dedupe and the review queue key off fw_applications, so that row is what keeps this
   * posting from coming straight back — as a re-recommend on the next run, or as a pending
   * card on the next page load. */
  async function handleDiscard(result: DailyLoopResult) {
    const key = pendingKey(result.company, result.title);
    setBusy(key, 'discarding');
    setCardError((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    try {
      await recordPass({
        company: result.company,
        title: result.title,
        grade: result.grade ?? null,
        source: 'daily_loop',
      });
      clearCard(key);
    } catch (err) {
      setCardError((prev) => ({
        ...prev,
        [key]:
          (err instanceof Error ? err.message : 'Could not record the pass.') +
          ' — the card stays until the pass is recorded.',
      }));
      setBusy(key, null);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-base font-semibold text-text">Run daily loop</h2>
        <p className="mt-1 max-w-2xl text-sm text-text-dim">
          The big hitter: searches the web for live postings matching your target titles,
          skips everything you've already applied to or passed on, and grades the rest
          against your career record. The scored cards land below and wait until you file
          or discard each one — nothing enters the pipeline without a click.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleSourceRun}
            disabled={runState === 'loading'}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {runState === 'loading' && runKind === 'source' ? 'Searching & scoring…' : 'Run daily loop'}
          </button>
          <select
            value={sourceCount}
            onChange={(e) => setSourceCount(Number(e.target.value))}
            disabled={runState === 'loading'}
            aria-label="How many roles to source"
            className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent disabled:opacity-50"
          >
            {SOURCE_COUNTS.map((n) => (
              <option key={n} value={n}>
                Up to {n} roles
              </option>
            ))}
          </select>
          <p className="text-xs text-text-dim">Takes a minute or two.</p>
        </div>

        {runState === 'loading' && (
          <div className="mt-4 rounded-lg border border-border p-3">
            <BuildProgress
              stages={runKind === 'source' ? SOURCE_STAGES : SCORE_STAGES}
              done={runDone}
            />
          </div>
        )}

        {runState === 'ready' && runSummary && (
          <p className="mt-4 text-sm text-text-dim">{runSummary}</p>
        )}
        {runState === 'error' && errorMessage && (
          <p className="mt-4 text-sm text-danger">{errorMessage}</p>
        )}
        {runErrors.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {runErrors.map((r, i) => (
              <div
                key={`${r.company}-${r.title ?? ''}-${i}`}
                className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger"
              >
                {r.company} — {r.title ?? 'Untitled role'}: {r.error ?? 'No grade returned.'}
              </div>
            ))}
          </div>
        )}

        <div className="mt-4 border-t border-border pt-4">
          <button
            type="button"
            onClick={() => setPasteOpen((v) => !v)}
            aria-expanded={pasteOpen}
            className="inline-flex items-center gap-1.5 text-sm text-text-dim hover:text-text"
          >
            <IconChevronDown
              className={`h-4 w-4 transition-transform ${pasteOpen ? '' : '-rotate-90'}`}
            />
            Or paste candidates you've already found
          </button>

          {pasteOpen && (
            <form onSubmit={handlePasteRun} className="mt-3 flex flex-col gap-3">
              {rows.map((row, i) => (
                <div key={i} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-2">
                  <input
                    value={row.company}
                    onChange={(e) => updateRow(i, { company: e.target.value })}
                    placeholder="Company"
                    className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
                  />
                  <input
                    value={row.title}
                    onChange={(e) => updateRow(i, { title: e.target.value })}
                    placeholder="Title"
                    className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
                  />
                  <input
                    value={row.url}
                    onChange={(e) => updateRow(i, { url: e.target.value })}
                    placeholder="URL (optional)"
                    className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent sm:col-span-2"
                  />
                  <textarea
                    value={row.jd_text}
                    onChange={(e) => updateRow(i, { jd_text: e.target.value })}
                    rows={3}
                    placeholder="JD text (optional if URL is fetchable)"
                    className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent sm:col-span-2"
                  />
                  {rows.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeRow(i)}
                      className="justify-self-start text-xs text-text-dim hover:text-danger sm:col-span-2"
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={addRow}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-dim transition-colors hover:text-text"
                >
                  + Add another
                </button>
                <button
                  type="submit"
                  disabled={runState === 'loading'}
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {runState === 'loading' && runKind === 'score' ? 'Scoring…' : 'Score candidates'}
                </button>
              </div>
            </form>
          )}
        </div>
      </section>

      {(pending.length > 0 || pendingNote) && (
        <section>
          <h2 className="text-base font-semibold text-text">
            Waiting for review{pending.length > 0 ? ` (${pending.length})` : ''}
          </h2>
          <p className="mt-1 text-xs text-text-dim">
            Graded cards stay here — including across reloads — until each one is filed to
            the pipeline or discarded.
          </p>
          {pendingNote && <p className="mt-3 text-sm text-danger">{pendingNote}</p>}
          <div className="mt-3 flex flex-col gap-3">
            {pending.map((result) => {
              const key = pendingKey(result.company, result.title);
              if (!result.grade) return null;
              return (
                <div key={key} className="flex flex-col gap-1">
                  <VerdictCardView
                    card={{
                      grade: result.grade,
                      comp_min: result.comp_min ?? null,
                      comp_max: result.comp_max ?? null,
                      remote_type: result.remote_type ?? null,
                      location: result.location ?? null,
                      pain_line: result.pain_line ?? null,
                      gaps: result.gaps ?? [],
                      reasoning: result.reasoning ?? '',
                      liveness_note: result.liveness_note,
                    }}
                    heading={`${result.company} — ${result.title ?? 'Untitled role'}`}
                    onFile={() => handleFile(result)}
                    onDiscard={() => handleDiscard(result)}
                    filing={cardBusy[key] === 'filing'}
                    discarding={cardBusy[key] === 'discarding'}
                  />
                  {cardError[key] && <p className="text-sm text-danger">{cardError[key]}</p>}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
