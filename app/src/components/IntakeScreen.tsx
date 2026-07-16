import { useState, type FormEvent } from 'react';
import { fileAsToApply, runScorecard, type VerdictCard } from '../lib/intake';
import VerdictCardView from './VerdictCardView';
import BuildProgress from './BuildProgress';

/** Mirrors the scorecard edge function's real flow (read profile -> liveness check ->
 * extract comp/location -> grade), so the label is describing what is actually happening
 * rather than inventing reassurance. */
const SCORE_STAGES = [
  'Reading your career record…',
  'Checking the posting is still live…',
  'Pulling out comp, location, and requirements…',
  'Grading the role…',
];

type ScoreState = 'idle' | 'loading' | 'ready' | 'error';
type FileState = 'idle' | 'filing' | 'filed' | 'discarded';

export default function IntakeScreen() {
  const [company, setCompany] = useState('');
  const [title, setTitle] = useState('');
  const [jdText, setJdText] = useState('');
  const [url, setUrl] = useState('');

  const [scoreState, setScoreState] = useState<ScoreState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [card, setCard] = useState<VerdictCard | null>(null);
  const [fileState, setFileState] = useState<FileState>('idle');
  const [fileError, setFileError] = useState<string | null>(null);
  const [scoreDone, setScoreDone] = useState(false);

  async function handleScore(e: FormEvent) {
    e.preventDefault();
    if (!jdText.trim() && !url.trim()) {
      setErrorMessage('Paste the JD text or provide a URL first.');
      setScoreState('error');
      return;
    }
    setScoreState('loading');
    setScoreDone(false);
    setErrorMessage(null);
    setCard(null);
    setFileState('idle');
    try {
      const result = await runScorecard({
        jd_text: jdText.trim() || undefined,
        url: url.trim() || undefined,
        // Not used for scoring — carried so the logged run item is a complete card that can
        // be reopened and filed if this render never makes it to the screen.
        company: company.trim() || undefined,
        title: title.trim() || undefined,
      });
      // Snap the progress bar to 100% and let it land before the card replaces it.
      setScoreDone(true);
      await new Promise((resolve) => setTimeout(resolve, 450));
      setCard(result);
      setScoreState('ready');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Scorecard failed.');
      setScoreState('error');
    }
  }

  async function handleFile() {
    if (!card) return;
    if (!company.trim()) {
      setFileError('Add a company name before filing.');
      return;
    }
    setFileState('filing');
    setFileError(null);
    try {
      await fileAsToApply({
        company: company.trim(),
        title: title.trim() || null,
        card,
        url: url.trim() || null,
      });
      setFileState('filed');
    } catch (err) {
      setFileError(err instanceof Error ? err.message : 'Could not file this application.');
      setFileState('idle');
    }
  }

  function handleDiscard() {
    setFileState('discarded');
  }

  function handleReset() {
    setCompany('');
    setTitle('');
    setJdText('');
    setUrl('');
    setCard(null);
    setScoreState('idle');
    setFileState('idle');
    setErrorMessage(null);
    setFileError(null);
  }

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={handleScore} className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs text-text-dim">
            Company
            <input
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="e.g. Acme Corp"
              className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-text-dim">
            Title
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Senior PM"
              className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent"
            />
          </label>
        </div>

        <label className="flex flex-col gap-1 text-xs text-text-dim">
          URL (optional — used for a liveness check)
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-text-dim">
          Job description text
          <textarea
            value={jdText}
            onChange={(e) => setJdText(e.target.value)}
            rows={8}
            placeholder="Paste the JD here — or leave blank if the URL is enough to fetch it."
            className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent"
          />
        </label>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={scoreState === 'loading'}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {scoreState === 'loading' ? 'Scoring…' : 'Scorecard'}
          </button>
          {(card || errorMessage) && (
            <button
              type="button"
              onClick={handleReset}
              className="text-xs text-text-dim hover:text-text"
            >
              Clear
            </button>
          )}
        </div>

        {scoreState === 'error' && errorMessage && (
          <p className="text-sm text-danger">{errorMessage}</p>
        )}
      </form>

      {scoreState === 'loading' && (
        <div className="rounded-xl border border-border bg-surface p-5">
          <BuildProgress stages={SCORE_STAGES} done={scoreDone} />
        </div>
      )}

      {card && (
        <div className="flex flex-col gap-2">
          <VerdictCardView
            card={card}
            heading={`${company.trim() || 'Untitled company'} — ${title.trim() || 'Untitled role'}`}
            onFile={handleFile}
            onDiscard={handleDiscard}
            filing={fileState === 'filing'}
            filed={fileState === 'filed'}
            discarded={fileState === 'discarded'}
          />
          {fileError && <p className="text-sm text-danger">{fileError}</p>}
        </div>
      )}
    </div>
  );
}
