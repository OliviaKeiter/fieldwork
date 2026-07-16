import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { IconArrowRight } from './icons';
import { getProfile, updateProfile, parseListInput, formatListInput } from '../lib/profile';
import { extractTextFromFile } from '../lib/fileExtract';
import {
  getTimingSettings,
  getWhimsyLevel,
  upsertSetting,
  type TimingSettings,
  type WhimsyLevel,
} from '../lib/settings';
import { loadExportBundle, buildApplicationsCsv, buildApplicationsMarkdown, downloadTextFile } from '../lib/exportData';
import { localDateString } from '../lib/dateUtils';
import type { FwProfile } from '../lib/types';

type LoadState = 'loading' | 'ready' | 'error';
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export default function SettingsForm() {
  const [state, setState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);

  const [profile, setProfile] = useState<FwProfile | null>(null);
  const [careerRecord, setCareerRecord] = useState('');
  const [lockedSummary, setLockedSummary] = useState('');
  const [compFloor, setCompFloor] = useState('');
  const [targetBandStrategy, setTargetBandStrategy] = useState('');
  const [remotePrefs, setRemotePrefs] = useState('');
  const [targetTitles, setTargetTitles] = useState('');
  const [avoidTitles, setAvoidTitles] = useState('');
  const [doNotClaim, setDoNotClaim] = useState('');
  const [neverMention, setNeverMention] = useState('');
  const [profileSave, setProfileSave] = useState<SaveState>('idle');
  const [profileError, setProfileError] = useState<string | null>(null);
  const [uploadState, setUploadState] = useState<'idle' | 'reading' | 'error'>('idle');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [timing, setTiming] = useState<TimingSettings>({
    nudge_days_min: 5,
    nudge_days_max: 7,
    ghost_days: 30,
    thankyou_hours: 24,
  });
  const [rulesSave, setRulesSave] = useState<SaveState>('idle');
  const [rulesError, setRulesError] = useState<string | null>(null);

  const [whimsy, setWhimsy] = useState<WhimsyLevel>('gentle');
  const [whimsySave, setWhimsySave] = useState<SaveState>('idle');

  const [exportState, setExportState] = useState<'idle' | 'working' | 'error'>('idle');
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [p, t, w] = await Promise.all([
          getProfile(),
          getTimingSettings(),
          getWhimsyLevel(),
        ]);
        if (p) {
          setProfile(p);
          setCareerRecord(p.career_record ?? '');
          setLockedSummary(p.locked_summary ?? '');
          setCompFloor(p.comp_floor != null ? String(p.comp_floor) : '');
          setTargetBandStrategy(p.target_band_strategy ?? '');
          setRemotePrefs(p.remote_prefs ?? '');
          setTargetTitles(formatListInput(p.target_titles));
          setAvoidTitles(formatListInput(p.avoid_titles));
          setDoNotClaim(formatListInput(p.do_not_claim));
          setNeverMention(formatListInput(p.never_mention));
        }
        setTiming(t);
        setWhimsy(w);
        setState('ready');
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load settings.');
        setState('error');
      }
    })();
  }, []);

  async function handleSaveProfile(e: FormEvent) {
    e.preventDefault();
    if (!profile) return;
    setProfileSave('saving');
    setProfileError(null);
    try {
      await updateProfile(profile.id, {
        career_record: careerRecord || null,
        locked_summary: lockedSummary || null,
        comp_floor: compFloor ? Number(compFloor) : null,
        target_band_strategy: targetBandStrategy || null,
        remote_prefs: remotePrefs || null,
        target_titles: parseListInput(targetTitles),
        avoid_titles: parseListInput(avoidTitles),
        do_not_claim: parseListInput(doNotClaim),
        never_mention: parseListInput(neverMention),
      });
      setProfileSave('saved');
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : 'Could not save the profile.');
      setProfileSave('error');
    }
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

  async function handleSaveRules(e: FormEvent) {
    e.preventDefault();
    setRulesSave('saving');
    setRulesError(null);
    try {
      await upsertSetting('timing', timing);
      setRulesSave('saved');
    } catch (err) {
      setRulesError(err instanceof Error ? err.message : 'Could not save the rules.');
      setRulesSave('error');
    }
  }

  async function handleWhimsyChange(next: WhimsyLevel) {
    setWhimsy(next);
    setWhimsySave('saving');
    try {
      await upsertSetting('whimsy', next);
      setWhimsySave('saved');
    } catch {
      setWhimsySave('error');
    }
  }

  async function handleExport(format: 'csv' | 'md') {
    setExportState('working');
    setExportError(null);
    try {
      const bundle = await loadExportBundle();
      const today = localDateString();
      if (format === 'csv') {
        downloadTextFile(`fieldwork-export-${today}.csv`, buildApplicationsCsv(bundle), 'text/csv');
      } else {
        downloadTextFile(`fieldwork-export-${today}.md`, buildApplicationsMarkdown(bundle), 'text/markdown');
      }
      setExportState('idle');
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Could not build the export.');
      setExportState('error');
    }
  }

  if (state === 'loading') {
    return <p className="text-sm text-text-dim">Loading settings…</p>;
  }

  if (state === 'error') {
    return (
      <div className="rounded-xl border border-danger/40 bg-surface p-6 text-sm text-danger">
        {loadError ?? 'Something went wrong loading settings.'}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Career record / profile */}
      <section className="rounded-xl border border-border bg-surface p-6">
        <h2 className="text-lg font-medium text-text">Career record & profile</h2>
        <p className="mt-2 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-text">
          Every AI action reads this record; nothing generated may exceed it.
        </p>

        {!profile ? (
          <p className="mt-4 text-sm text-text-dim">
            No profile row exists yet — create one via the onboarding wizard or import.
          </p>
        ) : (
          <form onSubmit={handleSaveProfile} className="mt-4 flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-text-dim">Career record (markdown)</span>
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
              <p className="text-xs text-text-dim">
                Uploading appends the extracted text below — review and edit it before saving.
                Nothing is written to your profile until you click Save.
              </p>
              <textarea
                value={careerRecord}
                onChange={(e) => setCareerRecord(e.target.value)}
                rows={14}
                className="rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs text-text outline-none focus:border-accent"
              />
            </div>
            <label className="flex flex-col gap-1 text-sm text-text-dim">
              Locked summary
              <textarea
                value={lockedSummary}
                onChange={(e) => setLockedSummary(e.target.value)}
                rows={3}
                className="rounded-lg border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
              />
            </label>
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
            <label className="flex flex-col gap-1 text-sm text-text-dim">
              Target titles (comma separated)
              <input
                value={targetTitles}
                onChange={(e) => setTargetTitles(e.target.value)}
                className="rounded-lg border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-text-dim">
              Avoid titles (comma separated)
              <input
                value={avoidTitles}
                onChange={(e) => setAvoidTitles(e.target.value)}
                className="rounded-lg border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-text-dim">
              Do not claim (comma separated)
              <input
                value={doNotClaim}
                onChange={(e) => setDoNotClaim(e.target.value)}
                className="rounded-lg border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-text-dim">
              Never mention (comma separated)
              <input
                value={neverMention}
                onChange={(e) => setNeverMention(e.target.value)}
                className="rounded-lg border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
              />
            </label>

            {profileError && <p className="text-sm text-danger">{profileError}</p>}

            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={profileSave === 'saving'}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {profileSave === 'saving' ? 'Saving…' : 'Save profile'}
              </button>
              {profileSave === 'saved' && (
                <span className="text-sm text-success">Saved.</span>
              )}
            </div>
          </form>
        )}
      </section>

      {/* Timing rules */}
      <section className="rounded-xl border border-border bg-surface p-6">
        <h2 className="text-lg font-medium text-text">Rules</h2>
        <p className="mt-1 text-sm text-text-dim">
          Timing thresholds that drive the Today queue.
        </p>
        <form onSubmit={handleSaveRules} className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <label className="flex flex-col gap-1 text-sm text-text-dim">
            Nudge after (days, min)
            <input
              type="number"
              value={timing.nudge_days_min}
              onChange={(e) =>
                setTiming((t) => ({ ...t, nudge_days_min: Number(e.target.value) }))
              }
              className="rounded-lg border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-text-dim">
            Nudge after (days, max)
            <input
              type="number"
              value={timing.nudge_days_max}
              onChange={(e) =>
                setTiming((t) => ({ ...t, nudge_days_max: Number(e.target.value) }))
              }
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
            <span className="text-xs text-text-dim">
              Silence this long moves an application to ghosted on its own. It stays in Pipeline
              and still counts in Insights.
            </span>
          </label>
          <label className="flex flex-col gap-1 text-sm text-text-dim">
            Thank-you within (hours)
            <input
              type="number"
              value={timing.thankyou_hours}
              onChange={(e) =>
                setTiming((t) => ({ ...t, thankyou_hours: Number(e.target.value) }))
              }
              className="rounded-lg border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
            />
          </label>
          <div className="col-span-full flex items-center gap-3">
            <button
              type="submit"
              disabled={rulesSave === 'saving'}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {rulesSave === 'saving' ? 'Saving…' : 'Save rules'}
            </button>
            {rulesSave === 'saved' && <span className="text-sm text-success">Saved.</span>}
            {rulesError && <p className="text-sm text-danger">{rulesError}</p>}
          </div>
        </form>
      </section>

      {/* Whimsy dial */}
      <section className="rounded-xl border border-border bg-surface p-6">
        <h2 className="text-lg font-medium text-text">Whimsy</h2>
        <p className="mt-1 text-sm text-text-dim">
          Warm microcopy elsewhere in the app. Rejection-adjacent screens stay plain no matter
          what this is set to.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <select
            value={whimsy}
            onChange={(e) => handleWhimsyChange(e.target.value as WhimsyLevel)}
            className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent"
          >
            <option value="off">Off</option>
            <option value="gentle">Gentle</option>
            <option value="full">Full</option>
          </select>
          {whimsySave === 'saved' && <span className="text-sm text-success">Saved.</span>}
        </div>
      </section>

      {/* Data export */}
      <section className="rounded-xl border border-border bg-surface p-6">
        <h2 className="text-lg font-medium text-text">Data export</h2>
        <p className="mt-1 text-sm text-text-dim">
          The user's data walks out the door freely — applications, JDs, contacts, events,
          and the lessons log, joined into one file, no lock-in.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={exportState === 'working'}
            onClick={() => handleExport('csv')}
            className="rounded-lg border border-border px-4 py-2 text-sm text-text transition-colors hover:border-accent disabled:opacity-50"
          >
            {exportState === 'working' ? 'Building…' : 'Export CSV'}
          </button>
          <button
            type="button"
            disabled={exportState === 'working'}
            onClick={() => handleExport('md')}
            className="rounded-lg border border-border px-4 py-2 text-sm text-text transition-colors hover:border-accent disabled:opacity-50"
          >
            {exportState === 'working' ? 'Building…' : 'Export Markdown'}
          </button>
          {exportError && <p className="text-sm text-danger">{exportError}</p>}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-6">
        <h2 className="text-lg font-medium text-text">Onboarding wizard</h2>
        <p className="mt-1 text-sm text-text-dim">
          Rebuild the record/rules/hooks/titles setup interview from scratch.
        </p>
        <a
          href="/onboarding"
          className="group mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-sm text-text-dim transition-colors hover:text-text"
        >
          Open onboarding wizard
          <IconArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        </a>
      </section>
    </div>
  );
}
