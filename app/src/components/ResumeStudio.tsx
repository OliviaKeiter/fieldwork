import { useEffect, useRef, useState } from 'react';
import {
  buildResumeContent,
  recordResumeBuilt,
  resolveFileName,
  saveResumeContent,
  type ResumeCertificationEntry,
  type ResumeContent,
} from '../lib/resume';
import BuildProgress from './BuildProgress';
import {
  buildResumeDocx,
  downloadBlob,
  renderResumePrintHtml,
  resolveResumeStyle,
  RESUME_LAYOUTS,
  RESUME_COLORS,
  DEFAULT_RESUME_STYLE,
  type ResumeStyle,
  type ResumeLayoutId,
  type ResumeColorId,
} from '../lib/resumeDocx';
import { getResumeStyleSettings, upsertSetting } from '../lib/settings';
import { getProfile } from '../lib/profile';
import { parseListInput, formatListInput } from '../lib/profile';
import type { FwApplication } from '../lib/types';

type State = 'idle' | 'building' | 'review' | 'error';

interface Props {
  application: FwApplication;
  onBuilt?: () => void;
  /** True when the dossier header asked for a build — consumed once on mount/change. */
  autoBuild?: boolean;
  /** Called after an autoBuild request has been picked up, so the parent can clear it. */
  onAutoBuildConsumed?: () => void;
  /** Reports whether a resume build is in flight (drives the header button state). */
  onBuildingChange?: (building: boolean) => void;
}

const RESUME_BUILD_STAGES = [
  'Reading your career record…',
  'Studying the job description…',
  'Matching experience to the role…',
  'Assembling the resume…',
];

const emptyContent: ResumeContent = {
  contact: { name: null, email: null, phone: null, linkedin: null, location: null, other: null },
  summary: '',
  experience: [],
  skills: [],
  education: [],
};

export default function ResumeStudio({
  application,
  onBuilt,
  autoBuild,
  onAutoBuildConsumed,
  onBuildingChange,
}: Props) {
  const [state, setState] = useState<State>('idle');
  const [buildDone, setBuildDone] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [content, setContent] = useState<ResumeContent>(emptyContent);
  const [atsKeywords, setAtsKeywords] = useState<string[]>([]);
  const [skillsInput, setSkillsInput] = useState('');
  const [downloadState, setDownloadState] = useState<'idle' | 'working' | 'done'>('idle');
  const [printState, setPrintState] = useState<'idle' | 'working'>('idle');
  const [style, setStyle] = useState<ResumeStyle>(DEFAULT_RESUME_STYLE);

  // Restore the last persisted build (fw_applications.resume_content) so a past resume can
  // be viewed, re-edited, and re-exported without regenerating. Skipped when the header
  // asked for a fresh build — that flow lands in `review` via handleBuild instead.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || autoBuild) return;
    restoredRef.current = true;
    const saved = application.resume_content;
    if (saved && state === 'idle') {
      setContent(saved);
      setSkillsInput(formatListInput(saved.skills ?? []));
      setState('review');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [application.resume_content, autoBuild]);

  // Restore the last-used layout+color from fw_settings (keys `resume_layout` /
  // `resume_color`, falling back to the legacy `resume_template` mapping for users who
  // saved a pick before the split); values are validated so stale/unknown ids silently
  // fall back to the default.
  useEffect(() => {
    let cancelled = false;
    getResumeStyleSettings()
      .then((raw) => {
        if (!cancelled) setStyle(resolveResumeStyle(raw));
      })
      .catch(() => {
        /* fall back to default style */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function selectLayout(layout: ResumeLayoutId) {
    setStyle((s) => ({ ...s, layout }));
    // Persist fire-and-forget — a failed save should never block the export flow.
    upsertSetting('resume_layout', layout).catch(() => {});
  }

  function selectColor(color: ResumeColorId) {
    setStyle((s) => ({ ...s, color }));
    upsertSetting('resume_color', color).catch(() => {});
  }

  async function handleBuild() {
    setState('building');
    setBuildDone(false);
    setErrorMessage(null);
    try {
      const res = await buildResumeContent(application.id);
      // Snap the progress bar to 100% and let it land before flipping to review.
      setBuildDone(true);
      await new Promise((resolve) => setTimeout(resolve, 450));
      setContent(res.content);
      setAtsKeywords(res.ats_keywords);
      setSkillsInput(formatListInput(res.content.skills));
      setState('review');
      // Persist the fresh build immediately — non-fatal, the export paths save again with
      // any human edits applied.
      saveResumeContent(application.id, res.content).catch(() => {});
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not build resume content.');
      setState('error');
    }
  }

  // Report in-flight state up so the dossier header button can mirror it.
  useEffect(() => {
    onBuildingChange?.(state === 'building');
  }, [state, onBuildingChange]);
  useEffect(() => () => onBuildingChange?.(false), [onBuildingChange]);

  // A header-initiated build: consume the request exactly once, then run the same
  // handleBuild path the tab's own button uses.
  const autoBuildStarted = useRef(false);
  useEffect(() => {
    if (autoBuild && !autoBuildStarted.current) {
      autoBuildStarted.current = true;
      onAutoBuildConsumed?.();
      void handleBuild();
    } else if (!autoBuild) {
      autoBuildStarted.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoBuild]);

  function updateContact(field: keyof ResumeContent['contact'], value: string) {
    setContent((c) => ({ ...c, contact: { ...c.contact, [field]: value || null } }));
  }

  function updateExperience(index: number, patch: Partial<ResumeContent['experience'][number]>) {
    setContent((c) => ({
      ...c,
      experience: c.experience.map((job, i) => (i === index ? { ...job, ...patch } : job)),
    }));
  }

  function removeExperience(index: number) {
    setContent((c) => ({ ...c, experience: c.experience.filter((_, i) => i !== index) }));
  }

  function addExperience() {
    setContent((c) => ({
      ...c,
      experience: [...c.experience, { title: '', company: '', dates: '', location: '', bullets: [] }],
    }));
  }

  function updateHighlightHeading(value: string) {
    setContent((c) => ({
      ...c,
      highlight: { heading: value, items: c.highlight?.items ?? [] },
    }));
  }

  function updateHighlightItem(index: number, patch: Partial<{ title: string; body: string }>) {
    setContent((c) => {
      if (!c.highlight) return c;
      return {
        ...c,
        highlight: {
          ...c.highlight,
          items: c.highlight.items.map((it, i) => (i === index ? { ...it, ...patch } : it)),
        },
      };
    });
  }

  function removeHighlightItem(index: number) {
    setContent((c) => {
      if (!c.highlight) return c;
      return { ...c, highlight: { ...c.highlight, items: c.highlight.items.filter((_, i) => i !== index) } };
    });
  }

  function addHighlightItem() {
    setContent((c) => ({
      ...c,
      highlight: {
        heading: c.highlight?.heading || 'Selected Impact',
        items: [...(c.highlight?.items ?? []), { title: '', body: '' }],
      },
    }));
  }

  function updateEducation(index: number, patch: Partial<ResumeContent['education'][number]>) {
    setContent((c) => ({
      ...c,
      education: c.education.map((ed, i) => (i === index ? { ...ed, ...patch } : ed)),
    }));
  }

  function removeEducation(index: number) {
    setContent((c) => ({ ...c, education: c.education.filter((_, i) => i !== index) }));
  }

  function addEducation() {
    setContent((c) => ({ ...c, education: [...c.education, { credential: '', institution: '', dates: '' }] }));
  }

  /* certifications is optional on ResumeContent (resumes saved before the field existed
     still parse), so every accessor coalesces to [] rather than assuming an array. */
  function updateCertification(index: number, patch: Partial<ResumeCertificationEntry>) {
    setContent((c) => ({
      ...c,
      certifications: (c.certifications ?? []).map((cert, i) => (i === index ? { ...cert, ...patch } : cert)),
    }));
  }

  function removeCertification(index: number) {
    setContent((c) => ({ ...c, certifications: (c.certifications ?? []).filter((_, i) => i !== index) }));
  }

  function addCertification() {
    setContent((c) => ({
      ...c,
      certifications: [...(c.certifications ?? []), { name: '', issuer: null, date: null }],
    }));
  }

  function currentContent(): ResumeContent {
    return { ...content, skills: parseListInput(skillsInput) };
  }

  async function handleDownload() {
    setDownloadState('working');
    setErrorMessage(null);
    try {
      const finalContent = currentContent();
      const profile = await getProfile();
      const filename = resolveFileName(profile?.file_name_pattern, application, finalContent.contact.name);
      const blob = await buildResumeDocx(finalContent, style);
      downloadBlob(blob, filename);
      await recordResumeBuilt(application.id, filename, finalContent);
      setDownloadState('done');
      onBuilt?.();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not build the .docx file.');
      setDownloadState('idle');
    }
  }

  function handlePrint() {
    setPrintState('working');
    // Persist the final edited content on this export path too — non-fatal.
    saveResumeContent(application.id, currentContent()).catch(() => {});
    // Give React a tick to paint #resume-print-root before invoking the print dialog.
    setTimeout(() => {
      window.print();
      setPrintState('idle');
    }, 50);
  }

  if (state === 'idle' || state === 'building' || state === 'error') {
    return (
      <div className="rounded-xl border border-border bg-surface p-6 text-sm">
        {application.resume_filename && (
          <p className="mb-3 text-text">
            Last built: <span className="font-medium">{application.resume_filename}</span>
          </p>
        )}
        {errorMessage && <p className="mb-3 text-danger">{errorMessage}</p>}
        {state === 'building' ? (
          <BuildProgress stages={RESUME_BUILD_STAGES} done={buildDone} />
        ) : (
          <button
            type="button"
            onClick={handleBuild}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Build resume
          </button>
        )}
      </div>
    );
  }

  const finalContent = currentContent();

  return (
    <div className="flex flex-col gap-6">
      <p className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-text">
        Every AI action reads the career record; nothing generated may exceed it. Review and
        edit everything below before exporting.
      </p>

      <section className="rounded-xl border border-border bg-surface p-4">
        <h3 className="text-sm font-medium text-text">Contact</h3>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {(['name', 'email', 'phone', 'linkedin', 'location', 'other'] as const).map((field) => (
            <label key={field} className="flex flex-col gap-1 text-xs capitalize text-text-dim">
              {field}
              <input
                value={content.contact[field] ?? ''}
                onChange={(e) => updateContact(field, e.target.value)}
                className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
              />
            </label>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-4">
        <h3 className="text-sm font-medium text-text">Summary</h3>
        <textarea
          value={content.summary}
          onChange={(e) => setContent((c) => ({ ...c, summary: e.target.value }))}
          rows={4}
          className="mt-3 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent"
        />
      </section>

      <section className="rounded-xl border border-border bg-surface p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-text">Experience</h3>
          <button
            type="button"
            onClick={addExperience}
            className="text-xs text-accent hover:underline"
          >
            + Add entry
          </button>
        </div>
        <div className="mt-3 flex flex-col gap-4">
          {content.experience.map((job, i) => (
            <div key={i} className="rounded-lg border border-border p-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input
                  value={job.title}
                  onChange={(e) => updateExperience(i, { title: e.target.value })}
                  placeholder="Title"
                  className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
                />
                <input
                  value={job.company}
                  onChange={(e) => updateExperience(i, { company: e.target.value })}
                  placeholder="Company"
                  className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
                />
                <input
                  value={job.dates}
                  onChange={(e) => updateExperience(i, { dates: e.target.value })}
                  placeholder="Dates"
                  className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
                />
                <input
                  value={job.location ?? ''}
                  onChange={(e) => updateExperience(i, { location: e.target.value })}
                  placeholder="Location"
                  className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
                />
              </div>
              <label className="mt-2 flex flex-col gap-1 text-xs text-text-dim">
                Bullets (one per line)
                <textarea
                  value={job.bullets.join('\n')}
                  onChange={(e) => updateExperience(i, { bullets: e.target.value.split('\n') })}
                  rows={Math.max(3, job.bullets.length)}
                  className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent"
                />
              </label>
              <button
                type="button"
                onClick={() => removeExperience(i)}
                className="mt-2 text-xs text-danger hover:underline"
              >
                Remove entry
              </button>
            </div>
          ))}
          {content.experience.length === 0 && (
            <p className="text-sm text-text-dim">No experience entries — add one above.</p>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-text">Highlights</h3>
          <button
            type="button"
            onClick={addHighlightItem}
            className="text-xs text-accent hover:underline"
          >
            + Add item
          </button>
        </div>
        <label className="mt-3 flex flex-col gap-1 text-xs text-text-dim">
          Section heading (e.g. Selected Impact, Flagship Products)
          <input
            value={content.highlight?.heading ?? ''}
            onChange={(e) => updateHighlightHeading(e.target.value)}
            placeholder="Selected Impact"
            className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
          />
        </label>
        <div className="mt-3 flex flex-col gap-3">
          {(content.highlight?.items ?? []).map((item, i) => (
            <div key={i} className="rounded-lg border border-border p-3">
              <input
                value={item.title}
                onChange={(e) => updateHighlightItem(i, { title: e.target.value })}
                placeholder="Title (product, initiative, win)"
                className="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
              />
              <textarea
                value={item.body}
                onChange={(e) => updateHighlightItem(i, { body: e.target.value })}
                placeholder="1-2 sentences, from the career record"
                rows={2}
                className="mt-2 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={() => removeHighlightItem(i)}
                className="mt-2 text-xs text-danger hover:underline"
              >
                Remove item
              </button>
            </div>
          ))}
          {(content.highlight?.items ?? []).length === 0 && (
            <p className="text-sm text-text-dim">No highlight items — add one above.</p>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-4">
        <h3 className="text-sm font-medium text-text">Skills (comma separated)</h3>
        <input
          value={skillsInput}
          onChange={(e) => setSkillsInput(e.target.value)}
          className="mt-3 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent"
        />
      </section>

      <section className="rounded-xl border border-border bg-surface p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-text">Education</h3>
          <button type="button" onClick={addEducation} className="text-xs text-accent hover:underline">
            + Add entry
          </button>
        </div>
        <div className="mt-3 flex flex-col gap-3">
          {content.education.map((ed, i) => (
            <div key={i} className="grid grid-cols-1 gap-2 rounded-lg border border-border p-3 sm:grid-cols-3">
              <input
                value={ed.credential}
                onChange={(e) => updateEducation(i, { credential: e.target.value })}
                placeholder="Credential"
                className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
              />
              <input
                value={ed.institution ?? ''}
                onChange={(e) => updateEducation(i, { institution: e.target.value })}
                placeholder="Institution"
                className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
              />
              <div className="flex gap-2">
                <input
                  value={ed.dates ?? ''}
                  onChange={(e) => updateEducation(i, { dates: e.target.value })}
                  placeholder="Dates"
                  className="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
                />
                <button type="button" onClick={() => removeEducation(i)} className="shrink-0 text-xs text-danger hover:underline">
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-text">Certifications &amp; Clearance</h3>
          <button type="button" onClick={addCertification} className="text-xs text-accent hover:underline">
            + Add entry
          </button>
        </div>
        <div className="mt-3 flex flex-col gap-3">
          {(content.certifications ?? []).map((cert, i) => (
            <div key={i} className="grid grid-cols-1 gap-2 rounded-lg border border-border p-3 sm:grid-cols-3">
              <input
                value={cert.name}
                onChange={(e) => updateCertification(i, { name: e.target.value })}
                placeholder="Credential (e.g. TS/SCI, AI-900)"
                className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
              />
              <input
                value={cert.issuer ?? ''}
                onChange={(e) => updateCertification(i, { issuer: e.target.value || null })}
                placeholder="Issuer / detail"
                className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
              />
              <div className="flex gap-2">
                <input
                  value={cert.date ?? ''}
                  onChange={(e) => updateCertification(i, { date: e.target.value || null })}
                  placeholder="Date"
                  className="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
                />
                <button type="button" onClick={() => removeCertification(i)} className="shrink-0 text-xs text-danger hover:underline">
                  Remove
                </button>
              </div>
            </div>
          ))}
          {(content.certifications ?? []).length === 0 && (
            <p className="text-sm text-text-dim">
              No certifications. Add one above, or rebuild from the record.
            </p>
          )}
        </div>
      </section>

      {atsKeywords.length > 0 && (
        <section className="rounded-xl border border-border bg-surface p-4">
          <h3 className="text-sm font-medium text-text">ATS keywords matched</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {atsKeywords.map((k) => (
              <span key={k} className="rounded-full border border-border bg-bg px-2 py-0.5 text-xs text-text-dim">
                {k}
              </span>
            ))}
          </div>
        </section>
      )}

      {errorMessage && <p className="text-sm text-danger">{errorMessage}</p>}

      <section className="rounded-xl border border-border bg-surface p-4">
        <h3 className="text-sm font-medium text-text">Layout</h3>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {RESUME_LAYOUTS.map((layout) => (
            <button
              key={layout.id}
              type="button"
              onClick={() => selectLayout(layout.id)}
              aria-pressed={style.layout === layout.id}
              className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                style.layout === layout.id
                  ? 'border-accent bg-accent/10'
                  : 'border-border hover:bg-surface-2'
              }`}
            >
              <span className={`block text-sm font-medium ${style.layout === layout.id ? 'text-accent' : 'text-text'}`}>
                {layout.label}
              </span>
              <span className="block text-xs text-text-dim">{layout.description}</span>
            </button>
          ))}
        </div>
        <h3 className="mt-4 text-sm font-medium text-text">Color</h3>
        <div className="mt-3 flex flex-wrap gap-2">
          {RESUME_COLORS.map((color) => (
            <button
              key={color.id}
              type="button"
              onClick={() => selectColor(color.id)}
              aria-pressed={style.color === color.id}
              className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors ${
                style.color === color.id
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border text-text hover:bg-surface-2'
              }`}
            >
              <span
                aria-hidden="true"
                className="h-4 w-4 rounded-full border border-black/10"
                style={{ backgroundColor: `#${color.accent}` }}
              />
              {color.label}
            </button>
          ))}
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={downloadState === 'working'}
          onClick={handleDownload}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {downloadState === 'working' ? 'Building…' : 'Download .docx'}
        </button>
        <button
          type="button"
          onClick={handlePrint}
          className="rounded-lg border border-border px-4 py-2 text-sm text-text transition-colors hover:bg-surface-2"
        >
          Print / Save PDF
        </button>
        <button
          type="button"
          onClick={handleBuild}
          className="rounded-lg border border-border px-4 py-2 text-sm text-text-dim transition-colors hover:text-text"
        >
          Rebuild from record
        </button>
        {downloadState === 'done' && <span className="text-sm text-success">Downloaded.</span>}
      </div>

      {/* Hidden except in print media — see #resume-print-root rules in global.css. */}
      <div dangerouslySetInnerHTML={{ __html: renderResumePrintHtml(finalContent, style) }} />
    </div>
  );
}
