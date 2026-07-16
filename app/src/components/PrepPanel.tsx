import { useState, type FormEvent } from 'react';
import { generatePrepDoc, logDebrief } from '../lib/prep';
import { formatDate, localDateString } from '../lib/dateUtils';
import BuildProgress from './BuildProgress';
import DraftPanel from './DraftPanel';
import type { FwPrepDoc } from '../lib/types';

const PREP_STAGES = [
  'Reading your career record…',
  'Reviewing the job description…',
  'Anticipating likely questions…',
  'Assembling your prep doc…',
];

interface Props {
  applicationId: string;
  prepDocs: FwPrepDoc[];
  onRefresh: () => Promise<void>;
}

type GenState = 'idle' | 'generating' | 'error';

const ROUND_TYPE_OPTIONS = ['phone_screen', 'technical', 'panel', 'final_round', 'general'];

export default function PrepPanel({ applicationId, prepDocs, onRefresh }: Props) {
  const [roundType, setRoundType] = useState('general');
  const [genState, setGenState] = useState<GenState>('idle');
  const [genError, setGenError] = useState<string | null>(null);

  const [debriefDrafts, setDebriefDrafts] = useState<Record<string, string>>({});
  const [debriefSaving, setDebriefSaving] = useState<string | null>(null);
  const [debriefError, setDebriefError] = useState<string | null>(null);

  const [thankYouDocId, setThankYouDocId] = useState<string | null>(null);
  const [genDone, setGenDone] = useState(false);

  async function handlePrepMe(e: FormEvent) {
    e.preventDefault();
    setGenState('generating');
    setGenDone(false);
    setGenError(null);
    try {
      await generatePrepDoc(applicationId, roundType || 'general');
      // Snap the progress bar to 100% and let it land before clearing.
      setGenDone(true);
      await new Promise((resolve) => setTimeout(resolve, 450));
      await onRefresh();
      setGenState('idle');
    } catch (err) {
      setGenError(err instanceof Error ? err.message : 'Could not generate a prep doc.');
      setGenState('error');
    }
  }

  async function handleLogDebrief(doc: FwPrepDoc) {
    const notes = (debriefDrafts[doc.id] ?? '').trim();
    if (!notes) return;
    setDebriefSaving(doc.id);
    setDebriefError(null);
    try {
      await logDebrief(doc.id, {
        date: localDateString(),
        round_type: doc.round_type,
        notes,
      });
      setDebriefDrafts((d) => ({ ...d, [doc.id]: '' }));
      await onRefresh();
    } catch (err) {
      setDebriefError(err instanceof Error ? err.message : 'Could not log that debrief.');
    } finally {
      setDebriefSaving(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <form
        onSubmit={handlePrepMe}
        className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-surface p-4"
      >
        <label className="flex flex-col gap-1 text-xs text-text-dim">
          Round type
          <input
            list="round-types"
            value={roundType}
            onChange={(e) => setRoundType(e.target.value)}
            className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
          />
          <datalist id="round-types">
            {ROUND_TYPE_OPTIONS.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
        <button
          type="submit"
          disabled={genState === 'generating'}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {genState === 'generating' ? 'Prepping…' : 'Prep me'}
        </button>
        {genState === 'generating' && (
          <div className="w-full">
            <BuildProgress stages={PREP_STAGES} done={genDone} />
          </div>
        )}
        {genError && <p className="w-full text-sm text-danger">{genError}</p>}
      </form>

      {prepDocs.length === 0 ? (
        <p className="text-sm text-text-dim">No prep doc yet — generate one above.</p>
      ) : (
        prepDocs.map((doc) => (
          <div key={doc.id} className="rounded-xl border border-border bg-surface p-4 text-sm">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-text-dim">{doc.round_type ?? 'General'}</p>
              <button
                type="button"
                onClick={() => setThankYouDocId(doc.id)}
                className="rounded-lg border border-border px-3 py-1 text-xs text-text transition-colors hover:bg-surface-2"
              >
                Draft thank-you
              </button>
            </div>
            {doc.content && <p className="mt-2 whitespace-pre-wrap text-text">{doc.content}</p>}

            <div className="mt-4 border-t border-border pt-3">
              <p className="text-xs uppercase tracking-wide text-text-dim">Debriefs logged</p>
              {Array.isArray(doc.debriefs) && doc.debriefs.length > 0 ? (
                <ol className="mt-2 flex flex-col gap-2">
                  {(doc.debriefs as { date: string; notes: string }[]).map((d, i) => (
                    <li key={i} className="rounded-lg border border-border bg-bg p-2 text-sm">
                      <span className="text-xs text-text-dim">{formatDate(d.date)}</span>
                      <p className="mt-0.5 text-text">{d.notes}</p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mt-1 text-text-dim">Nothing logged yet.</p>
              )}

              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
                <label className="flex flex-1 flex-col gap-1 text-xs text-text-dim">
                  Here's how it went…
                  <textarea
                    value={debriefDrafts[doc.id] ?? ''}
                    onChange={(e) => setDebriefDrafts((d) => ({ ...d, [doc.id]: e.target.value }))}
                    rows={2}
                    className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent"
                  />
                </label>
                <button
                  type="button"
                  disabled={debriefSaving === doc.id}
                  onClick={() => handleLogDebrief(doc)}
                  className="rounded-lg border border-border px-4 py-2 text-sm text-text transition-colors hover:bg-surface-2 disabled:opacity-50"
                >
                  {debriefSaving === doc.id ? 'Logging…' : 'Log debrief'}
                </button>
              </div>
              {debriefError && <p className="mt-2 text-sm text-danger">{debriefError}</p>}
            </div>
          </div>
        ))
      )}

      {thankYouDocId && (
        <DraftPanel
          type="thank_you"
          context={{ application_id: applicationId }}
          subjectLabel="Thank-you note"
          onClose={() => setThankYouDocId(null)}
        />
      )}
    </div>
  );
}
