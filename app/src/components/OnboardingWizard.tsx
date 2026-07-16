import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { getProfile, createProfile, updateProfile, parseListInput, formatListInput } from '../lib/profile';
import { getTimingSettings, upsertSetting, type TimingSettings } from '../lib/settings';
import { extractTextFromFile } from '../lib/fileExtract';
import type { FwProfile } from '../lib/types';

type Step = 'record' | 'rules' | 'hooks' | 'titles' | 'finish';

const STEPS: { key: Step; label: string; blurb: string }[] = [
  {
    key: 'record',
    label: 'Career record',
    blurb: 'Build the markdown record every generated artifact is checked against.',
  },
  {
    key: 'rules',
    label: 'Rules',
    blurb: 'Comp floor, target band strategy, remote prefs, and the timing thresholds behind the Today queue.',
  },
  {
    key: 'hooks',
    label: 'Hooks',
    blurb: 'Reusable opening lines for outreach, keyed by scenario.',
  },
  {
    key: 'titles',
    label: 'Titles',
    blurb: 'Target titles to search for, and titles to automatically avoid.',
  },
  {
    key: 'finish',
    label: 'Finish',
    blurb: "You're set up — here's what's next.",
  },
];

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface HookRow {
  name: string;
  text: string;
}

function hooksToRows(hooks: Record<string, string> | null | undefined): HookRow[] {
  const rows = Object.entries(hooks ?? {}).map(([name, text]) => ({ name, text }));
  return rows.length > 0 ? rows : [{ name: '', text: '' }];
}

function rowsToHooks(rows: HookRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const name = r.name.trim();
    if (name && r.text.trim()) out[name] = r.text.trim();
  }
  return out;
}

/**
 * The resume-builder setup interview as screens (SPEC.md §4.8). This is the least-trafficked
 * screen in the app — user #1 imported their data and never needs this path — but it is
 * built for real because the app is product-shaped (multi-user-ready, no hardcoded personal
 * facts). A brand-new user can step through it and land with a real fw_profile row; an
 * existing user gets a one-click explanation of why they should skip straight to the app.
 */
export default function OnboardingWizard() {
  const [step, setStep] = useState<Step>('record');
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasExistingProfile, setHasExistingProfile] = useState(false);

  const [profileId, setProfileId] = useState<string | null>(null);
  const [careerRecord, setCareerRecord] = useState('');
  const [uploadState, setUploadState] = useState<'idle' | 'reading' | 'error'>('idle');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [lockedSummary, setLockedSummary] = useState('');
  const [compFloor, setCompFloor] = useState('');
  const [targetBandStrategy, setTargetBandStrategy] = useState('');
  const [remotePrefs, setRemotePrefs] = useState('');
  const [targetTitles, setTargetTitles] = useState('');
  const [avoidTitles, setAvoidTitles] = useState('');
  const [hookRows, setHookRows] = useState<HookRow[]>([{ name: '', text: '' }]);
  const [timing, setTiming] = useState<TimingSettings>({
    nudge_days_min: 5,
    nudge_days_max: 7,
    ghost_days: 30,
    thankyou_hours: 24,
  });

  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [profile, t] = await Promise.all([getProfile(), getTimingSettings()]);
        if (profile) {
          setHasExistingProfile(true);
          setProfileId(profile.id);
          setCareerRecord(profile.career_record ?? '');
          setLockedSummary(profile.locked_summary ?? '');
          setCompFloor(profile.comp_floor != null ? String(profile.comp_floor) : '');
          setTargetBandStrategy(profile.target_band_strategy ?? '');
          setRemotePrefs(profile.remote_prefs ?? '');
          setTargetTitles(formatListInput(profile.target_titles));
          setAvoidTitles(formatListInput(profile.avoid_titles));
          setHookRows(hooksToRows(profile.hooks));
        }
        setTiming(t);
        setLoadState('ready');
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load onboarding data.');
        setLoadState('error');
      }
    })();
  }, []);

  /** Ensures a profile row exists, creating it on first save for a brand-new user. Returns
   * the id to update against from then on. */
  async function ensureProfileId(): Promise<string> {
    if (profileId) return profileId;
    const created = await createProfile({
      career_record: careerRecord || null,
      locked_summary: lockedSummary || null,
      hooks: {},
      target_titles: [],
      avoid_titles: [],
      do_not_claim: [],
      never_mention: [],
    });
    setProfileId(created.id);
    setHasExistingProfile(true);
    return created.id;
  }

  async function handleUploadFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadState('reading');
    setUploadError(null);
    try {
      const text = await extractTextFromFile(file);
      if (!text) {
        throw new Error('That file didn’t have any extractable text — try a different export of it.');
      }
      setCareerRecord((prev) => (prev.trim() ? `${prev.trim()}\n\n---\n\n${text}` : text));
      setUploadState('idle');
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Could not read that file.');
      setUploadState('error');
    }
  }

  async function handleSaveRecord(e: FormEvent) {
    e.preventDefault();
    setSaveState('saving');
    setSaveError(null);
    try {
      const id = await ensureProfileId();
      await updateProfile(id, {
        career_record: careerRecord || null,
        locked_summary: lockedSummary || null,
      });
      setSaveState('saved');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save the record.');
      setSaveState('error');
    }
  }

  async function handleSaveRules(e: FormEvent) {
    e.preventDefault();
    setSaveState('saving');
    setSaveError(null);
    try {
      const id = await ensureProfileId();
      await Promise.all([
        updateProfile(id, {
          comp_floor: compFloor ? Number(compFloor) : null,
          target_band_strategy: targetBandStrategy || null,
          remote_prefs: remotePrefs || null,
        }),
        upsertSetting('timing', timing),
      ]);
      setSaveState('saved');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save the rules.');
      setSaveState('error');
    }
  }

  async function handleSaveHooks(e: FormEvent) {
    e.preventDefault();
    setSaveState('saving');
    setSaveError(null);
    try {
      const id = await ensureProfileId();
      await updateProfile(id, { hooks: rowsToHooks(hookRows) });
      setSaveState('saved');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save hooks.');
      setSaveState('error');
    }
  }

  async function handleSaveTitles(e: FormEvent) {
    e.preventDefault();
    setSaveState('saving');
    setSaveError(null);
    try {
      const id = await ensureProfileId();
      await updateProfile(id, {
        target_titles: parseListInput(targetTitles),
        avoid_titles: parseListInput(avoidTitles),
      });
      setSaveState('saved');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save titles.');
      setSaveState('error');
    }
  }

  function goTo(next: Step) {
    setSaveState('idle');
    setSaveError(null);
    setStep(next);
  }

  const currentIndex = STEPS.findIndex((s) => s.key === step);

  if (loadState === 'loading') {
    return <p className="text-sm text-text-dim">Loading onboarding…</p>;
  }
  if (loadState === 'error') {
    return (
      <div className="rounded-xl border border-danger/40 bg-surface p-6 text-sm text-danger">
        {loadError ?? 'Something went wrong loading onboarding.'}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {hasExistingProfile && (
        <div className="rounded-xl border border-accent/30 bg-accent/10 p-4 text-sm text-text">
          You already have a career record on file (imported from the xlsx tracker). This
          wizard edits that same profile — for day-to-day changes,{' '}
          <a href="/settings" className="text-accent hover:underline">
            Settings
          </a>{' '}
          is faster. Actual xlsx import is a one-time script (SPEC.md §8), not something this
          wizard re-runs.
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {STEPS.map((s, i) => (
          <button
            key={s.key}
            type="button"
            onClick={() => goTo(s.key)}
            className={`flex-1 min-w-[7rem] rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
              s.key === step
                ? 'border-accent bg-accent/10 text-text'
                : 'border-border text-text-dim hover:text-text'
            }`}
          >
            <span className="text-xs text-text-dim">Step {i + 1}</span>
            <p className="font-medium">{s.label}</p>
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-border bg-surface p-6">
        <h2 className="text-lg font-medium text-text">{STEPS[currentIndex].label}</h2>
        <p className="mt-1 text-sm text-text-dim">{STEPS[currentIndex].blurb}</p>

        {step === 'record' && (
          <form onSubmit={handleSaveRecord} className="mt-4 flex flex-col gap-4">
            <p className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-text">
              Every AI action reads this record; nothing generated may exceed it.
            </p>
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-text-dim">
                  Career record (markdown) — paste, write, or upload your full career history
                </span>
                <div className="flex items-center gap-3">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".docx,.pdf,.md,.markdown,.txt"
                    onChange={handleUploadFile}
                    className="hidden"
                  />
                  <button
                    type="button"
                    disabled={uploadState === 'reading'}
                    onClick={() => fileInputRef.current?.click()}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs text-text transition-colors hover:border-accent disabled:opacity-50"
                  >
                    {uploadState === 'reading' ? 'Reading file…' : 'Upload resume / record (.docx, .pdf, .md, .txt)'}
                  </button>
                </div>
              </div>
              {uploadError && <p className="text-sm text-danger">{uploadError}</p>}
              <textarea
                value={careerRecord}
                onChange={(e) => setCareerRecord(e.target.value)}
                rows={12}
                placeholder="## Experience&#10;### Company — Title (dates)&#10;- Achievement…"
                className="rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs text-text outline-none focus:border-accent"
              />
            </div>
            <label className="flex flex-col gap-1 text-sm text-text-dim">
              Locked summary — the one-paragraph version every draft can quote from
              <textarea
                value={lockedSummary}
                onChange={(e) => setLockedSummary(e.target.value)}
                rows={3}
                className="rounded-lg border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
              />
            </label>
            <SaveRow saveState={saveState} saveError={saveError} label="Save record" />
          </form>
        )}

        {step === 'rules' && (
          <form onSubmit={handleSaveRules} className="mt-4 flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm text-text-dim">
                Comp floor
                <input
                  type="number"
                  value={compFloor}
                  onChange={(e) => setCompFloor(e.target.value)}
                  className="rounded-lg border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm text-text-dim">
                Target band strategy
                <input
                  value={targetBandStrategy}
                  onChange={(e) => setTargetBandStrategy(e.target.value)}
                  className="rounded-lg border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
                />
              </label>
            </div>
            <label className="flex flex-col gap-1 text-sm text-text-dim">
              Remote preferences
              <input
                value={remotePrefs}
                onChange={(e) => setRemotePrefs(e.target.value)}
                className="rounded-lg border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
              />
            </label>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <label className="flex flex-col gap-1 text-sm text-text-dim">
                Nudge after (days, min)
                <input
                  type="number"
                  value={timing.nudge_days_min}
                  onChange={(e) => setTiming((t) => ({ ...t, nudge_days_min: Number(e.target.value) }))}
                  className="rounded-lg border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm text-text-dim">
                Nudge after (days, max)
                <input
                  type="number"
                  value={timing.nudge_days_max}
                  onChange={(e) => setTiming((t) => ({ ...t, nudge_days_max: Number(e.target.value) }))}
                  className="rounded-lg border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm text-text-dim">
                Auto-ghost after (days)
                <input
                  type="number"
                  value={timing.ghost_days}
                  onChange={(e) => setTiming((t) => ({ ...t, ghost_days: Number(e.target.value) }))}
                  className="rounded-lg border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm text-text-dim">
                Thank-you within (hours)
                <input
                  type="number"
                  value={timing.thankyou_hours}
                  onChange={(e) => setTiming((t) => ({ ...t, thankyou_hours: Number(e.target.value) }))}
                  className="rounded-lg border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
                />
              </label>
            </div>
            <SaveRow saveState={saveState} saveError={saveError} label="Save rules" />
          </form>
        )}

        {step === 'hooks' && (
          <form onSubmit={handleSaveHooks} className="mt-4 flex flex-col gap-4">
            <p className="text-sm text-text-dim">
              A hook is a reusable opening line for outreach, keyed by scenario (e.g. "cold
              recruiter", "warm referral", "post-rejection stay-in-touch").
            </p>
            {hookRows.map((row, i) => (
              <div key={i} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[10rem_1fr]">
                <input
                  value={row.name}
                  onChange={(e) =>
                    setHookRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, name: e.target.value } : r)))
                  }
                  placeholder="Scenario name"
                  className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
                />
                <input
                  value={row.text}
                  onChange={(e) =>
                    setHookRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, text: e.target.value } : r)))
                  }
                  placeholder="Opening line"
                  className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
                />
                {hookRows.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setHookRows((prev) => prev.filter((_, idx) => idx !== i))}
                    className="text-left text-xs text-text-dim hover:text-danger sm:col-span-2"
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={() => setHookRows((prev) => [...prev, { name: '', text: '' }])}
              className="self-start rounded-lg border border-border px-3 py-1.5 text-xs text-text-dim transition-colors hover:text-text"
            >
              + Add hook
            </button>
            <SaveRow saveState={saveState} saveError={saveError} label="Save hooks" />
          </form>
        )}

        {step === 'titles' && (
          <form onSubmit={handleSaveTitles} className="mt-4 flex flex-col gap-4">
            <label className="flex flex-col gap-1 text-sm text-text-dim">
              Target titles (comma separated) — these drive daily-loop sourcing and scorecard weighting
              <input
                value={targetTitles}
                onChange={(e) => setTargetTitles(e.target.value)}
                className="rounded-lg border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-text-dim">
              Avoid titles (comma separated) — automatically flagged as a soft-no
              <input
                value={avoidTitles}
                onChange={(e) => setAvoidTitles(e.target.value)}
                className="rounded-lg border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
              />
            </label>
            <SaveRow saveState={saveState} saveError={saveError} label="Save titles" />
          </form>
        )}

        {step === 'finish' && (
          <div className="mt-4 flex flex-col gap-3 text-sm text-text-dim">
            <p>
              That's the setup interview. Your record, rules, hooks, and titles are saved to{' '}
              <code className="text-text">fw_profile</code> — every edge function (scorecard,
              daily loop, drafts, prep, resume) reads them from there, same as an imported
              user.
            </p>
            <p>
              From here: head to{' '}
              <a href="/intake" className="text-accent hover:underline">
                Intake
              </a>{' '}
              to score your first role, or{' '}
              <a href="/today" className="text-accent hover:underline">
                Today
              </a>{' '}
              to see the action queue.
            </p>
            <p className="rounded-lg border border-border bg-bg p-3 text-xs">
              Already had a tracker running elsewhere? xlsx import is a one-time script
              (SPEC.md §8) run outside the app, not this wizard — ask whoever set up your
              Fieldwork instance to run it, then just use the app directly.
            </p>
          </div>
        )}
      </div>

      <div className="flex justify-between">
        <button
          type="button"
          disabled={currentIndex === 0}
          onClick={() => goTo(STEPS[Math.max(0, currentIndex - 1)].key)}
          className="rounded-lg border border-border px-4 py-2 text-sm text-text-dim transition-colors hover:text-text disabled:opacity-40"
        >
          Back
        </button>
        <button
          type="button"
          disabled={currentIndex === STEPS.length - 1}
          onClick={() => goTo(STEPS[Math.min(STEPS.length - 1, currentIndex + 1)].key)}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}

function SaveRow({
  saveState,
  saveError,
  label,
}: {
  saveState: SaveState;
  saveError: string | null;
  label: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <button
        type="submit"
        disabled={saveState === 'saving'}
        className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {saveState === 'saving' ? 'Saving…' : label}
      </button>
      {saveState === 'saved' && <span className="text-sm text-success">Saved.</span>}
      {saveError && <p className="text-sm text-danger">{saveError}</p>}
    </div>
  );
}
