import { useEffect, useRef, useState } from 'react';
import { IconClose, IconCheck } from './icons';
import { generateDraftBody, insertDraft, updateDraftBody, markDraftSent, type DraftContext } from '../lib/drafts';
import { getApplication, insertEvent } from '../lib/applications';
import { getProfile } from '../lib/profile';
import { contactFromCareerRecord, resolveFileName, type ResumeContact } from '../lib/resume';
import {
  downloadBlob,
  resolveResumeStyle,
  RESUME_LAYOUTS,
  RESUME_COLORS,
  DEFAULT_RESUME_STYLE,
  type ResumeStyle,
  type ResumeLayoutId,
  type ResumeColorId,
} from '../lib/resumeDocx';
import { buildCoverLetterDocx, printCoverLetter, stripSignOff } from '../lib/coverLetterDocx';
import {
  getResumeStyleSettings,
  getCoverLetterSettings,
  upsertSetting,
  DEFAULT_COVER_LETTER_SETTINGS,
  type CoverLetterSettings,
} from '../lib/settings';
import type { FwApplication, FwDraft, FwDraftType, FwProfile } from '../lib/types';
import BuildProgress from './BuildProgress';

type State = 'generating' | 'ready' | 'error';

/** The draft edge function reads the profile + application context, then writes. Three
 * stages is honest for a call that is usually quicker than a resume build. */
const DRAFT_STAGES = [
  'Reading your career record…',
  'Pulling in the company context…',
  'Writing the draft…',
];

const TYPE_LABEL: Record<FwDraftType, string> = {
  hello: 'Hello',
  nudge: 'Nudge',
  thank_you: 'Thank-you',
  stay_in_touch: 'Stay in touch',
  cover_letter: 'Cover letter',
  application_question: 'Application question',
};

interface Props {
  type: FwDraftType;
  context: DraftContext;
  subjectLabel: string;
  /** Optional text prepended to the generated body before save/display — e.g. the
   * "Q: <question>" line for application_question drafts, so question and answer live
   * together in the saved fw_drafts row. */
  bodyPrefix?: string;
  onClose: () => void;
  /** Called after Mark sent succeeds, so the parent (Today/Contacts/Dossier) can refresh. */
  onSent?: () => void;
}

/** Reusable draft panel: generate → edit → [Copy] / [Mark sent]. SPEC.md principle #2 —
 * the app never sends anything itself. This is the one control every draft-shaped button
 * in the app (Today nudge/thank-you, Contacts row drafts, Dossier debrief thank-you) opens. */
export default function DraftPanel({ type, context, subjectLabel, bodyPrefix, onClose, onSent }: Props) {
  const [state, setState] = useState<State>('generating');
  const [genDone, setGenDone] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState<FwDraft | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [sending, setSending] = useState(false);
  // One "drafted" timeline event per panel session — Regenerate replaces the draft, it
  // isn't a new artifact from the timeline's point of view. (Mark sent logs separately,
  // inside markDraftSent, so there is exactly one logger per state change.)
  const draftEventLogged = useRef(false);

  // Cover-letter export state (only used when type === 'cover_letter'): the letter renders
  // as a styled .docx / print-PDF through the same layout+color specs as the resume,
  // defaulting to the saved `resume_layout`/`resume_color` settings (with the legacy
  // `resume_template` mapping as fallback) so letter + resume pair by default.
  const isCoverLetter = type === 'cover_letter';
  const [style, setStyle] = useState<ResumeStyle>(DEFAULT_RESUME_STYLE);
  const [application, setApplication] = useState<FwApplication | null>(null);
  const [profile, setProfile] = useState<FwProfile | null>(null);
  const [exportReady, setExportReady] = useState(false);
  const [docxState, setDocxState] = useState<'idle' | 'working' | 'done'>('idle');

  // Sign-off fields — their own inputs, NEVER part of the body text (a sign-off in the
  // body prints twice; see stripSignOff). Prefilled from the saved cover_letter settings,
  // name falling back to the career record's contact.
  const [signOff, setSignOff] = useState(DEFAULT_COVER_LETTER_SETTINGS.signoff);
  const [signName, setSignName] = useState('');
  const clSettings = useRef<CoverLetterSettings>(DEFAULT_COVER_LETTER_SETTINGS);

  useEffect(() => {
    if (!isCoverLetter || !context.application_id) return;
    let cancelled = false;
    Promise.all([
      getResumeStyleSettings().catch(() => null),
      getApplication(context.application_id),
      getProfile(),
      getCoverLetterSettings().catch(() => DEFAULT_COVER_LETTER_SETTINGS),
    ])
      .then(([savedStyle, app, prof, clPrefs]) => {
        if (cancelled) return;
        if (savedStyle) setStyle(resolveResumeStyle(savedStyle));
        setApplication(app);
        setProfile(prof);
        clSettings.current = clPrefs;
        setSignOff(clPrefs.signoff || DEFAULT_COVER_LETTER_SETTINGS.signoff);
        const contactName =
          app?.resume_content?.contact?.name || contactFromCareerRecord(prof?.career_record).name;
        setSignName(clPrefs.name || contactName || '');
        setExportReady(true);
      })
      .catch(() => {
        /* Export buttons stay disabled; the draft flow itself is unaffected. */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCoverLetter, context.application_id]);

  /** Persists the sign-off fields as the new defaults (fire-and-forget, keeps tone). */
  function saveSignOffPrefs() {
    const next = { ...clSettings.current, signoff: signOff.trim(), name: signName.trim() };
    clSettings.current = next;
    upsertSetting('cover_letter', next).catch(() => {});
  }

  // Same persisted settings the ResumeStudio picker writes — changing them here keeps the
  // next resume export matched to the letter. Fire-and-forget, never blocks the export.
  function selectLayout(layout: ResumeLayoutId) {
    setStyle((s) => ({ ...s, layout }));
    upsertSetting('resume_layout', layout).catch(() => {});
  }

  function selectColor(color: ResumeColorId) {
    setStyle((s) => ({ ...s, color }));
    upsertSetting('resume_color', color).catch(() => {});
  }

  /** Contact block for the letter header: the application's saved resume build is the best
   * source (already extracted from the career record for this role); otherwise fall back
   * to a client-side parse of the career record itself. Never hardcoded. */
  function letterContact(): ResumeContact {
    const fromResume = application?.resume_content?.contact;
    if (fromResume && (fromResume.name || fromResume.email)) return fromResume;
    return contactFromCareerRecord(profile?.career_record);
  }

  function letterFileName(contactName: string | null): string {
    const app = application ?? { company: 'Company', title: null };
    const base = resolveFileName(profile?.file_name_pattern, app, contactName);
    return base.replace(/\.docx$/i, '_CoverLetter.docx');
  }

  async function handleDownloadLetterDocx() {
    setDocxState('working');
    setErrorMessage(null);
    try {
      const contact = letterContact();
      const blob = await buildCoverLetterDocx(
        { contact, body, signOff, signatureName: signName },
        style
      );
      downloadBlob(blob, letterFileName(contact.name));
      setDocxState('done');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not build the .docx file.');
      setDocxState('idle');
    }
  }

  function handlePrintLetter() {
    setErrorMessage(null);
    printCoverLetter(
      { contact: letterContact(), body, signOff, signatureName: signName },
      style
    );
  }

  async function generate() {
    setState('generating');
    setGenDone(false);
    setErrorMessage(null);
    setCopyState('idle');
    try {
      const rawBody = await generateDraftBody(type, context);
      // Cover letters: the sign-off lives in its own fields, never the body (it would
      // print twice). The edge function is told not to write one; this catches stragglers
      // and pre-redeploy installs.
      const generatedBody = isCoverLetter ? stripSignOff(rawBody) : rawBody;
      const generated = bodyPrefix ? `${bodyPrefix}${generatedBody}` : generatedBody;
      const saved = await insertDraft({
        type,
        body: generated,
        application_id: context.application_id,
        contact_id: context.contact_id,
      });
      // Snap the progress bar to 100% and let it land before the draft replaces it.
      setGenDone(true);
      await new Promise((resolve) => setTimeout(resolve, 450));
      setBody(generated);
      setDraft(saved);
      setState('ready');
      if (context.application_id && !draftEventLogged.current) {
        draftEventLogged.current = true;
        // "drafted", not "answered" — Mark sent logs its own event (in markDraftSent), so
        // the timeline reads as the two real state changes: drafted, then sent.
        const eventBody =
          type === 'application_question'
            ? `Application question drafted: ${(context.extra_context ?? '').slice(0, 60)}`
            : `${TYPE_LABEL[type]} drafted`;
        // Non-fatal — a missed timeline note must never block the draft itself.
        insertEvent(context.application_id, 'note', eventBody).catch(() => {});
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not generate a draft.');
      setState('error');
    }
  }

  useEffect(() => {
    generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleBodyBlur() {
    if (draft && body !== draft.body) {
      try {
        await updateDraftBody(draft.id, body);
        setDraft({ ...draft, body });
      } catch {
        // Non-fatal — the human still has the edited text on screen; retried on next save point.
      }
    }
  }

  async function handleCopy() {
    try {
      // Cover letters copy WITH the sign-off appended — pasted into a portal it should be
      // the complete letter, even though the body box deliberately doesn't contain it.
      const text = isCoverLetter
        ? `${body.trimEnd()}\n\n${signOff.trim()}\n${signName.trim()}`.trimEnd()
        : body;
      await navigator.clipboard.writeText(text);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 1500);
    } catch {
      setErrorMessage('Could not copy to clipboard — select and copy the text manually.');
    }
  }

  async function handleMarkSent() {
    if (!draft) return;
    setSending(true);
    try {
      await handleBodyBlur();
      await markDraftSent({ ...draft, body });
      onSent?.();
      onClose();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not mark this as sent.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex w-full max-w-xl flex-col gap-4 rounded-xl border border-border bg-surface p-6 shadow-xl">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs uppercase tracking-wide text-text-dim">{TYPE_LABEL[type]} draft</p>
            <h2 className="mt-0.5 text-lg font-medium text-text">{subjectLabel}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close draft"
            className="rounded-lg p-1.5 text-text-dim transition-colors hover:bg-surface-2 hover:text-text"
          >
            <IconClose className="h-4 w-4" />
          </button>
        </div>

        {state === 'generating' && <BuildProgress stages={DRAFT_STAGES} done={genDone} />}

        {state === 'error' && (
          <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
            {errorMessage}
          </div>
        )}

        {state === 'ready' && (
          <>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onBlur={handleBodyBlur}
              rows={10}
              className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent"
            />
            {errorMessage && <p className="text-sm text-danger">{errorMessage}</p>}

            {isCoverLetter && (
              <div className="flex flex-col gap-2 rounded-lg border border-border bg-bg/50 p-3">
                <p className="text-xs uppercase tracking-wide text-text-dim">Sign-off</p>
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1 text-xs text-text-dim">
                    Closing line
                    <input
                      value={signOff}
                      onChange={(e) => setSignOff(e.target.value)}
                      onBlur={saveSignOffPrefs}
                      placeholder="Best wishes,"
                      className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-text-dim">
                    Name
                    <input
                      value={signName}
                      onChange={(e) => setSignName(e.target.value)}
                      onBlur={saveSignOffPrefs}
                      placeholder="Your name"
                      className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
                    />
                  </label>
                </div>
                <p className="text-xs text-text-dim">
                  Kept out of the letter text so it can never print twice — Copy, .docx, and
                  PDF all add it as its own block. Saved as your default; a tone preference
                  lives in Settings → Cover letters.
                </p>
                <p className="text-xs uppercase tracking-wide text-text-dim">
                  Layout (matches your resume)
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {RESUME_LAYOUTS.map((layout) => (
                    <button
                      key={layout.id}
                      type="button"
                      onClick={() => selectLayout(layout.id)}
                      aria-pressed={style.layout === layout.id}
                      className={`rounded-lg border px-2 py-1.5 text-left text-xs transition-colors ${
                        style.layout === layout.id
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-border text-text hover:bg-surface-2'
                      }`}
                    >
                      {layout.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs uppercase tracking-wide text-text-dim">Color</p>
                <div className="flex flex-wrap gap-1.5">
                  {RESUME_COLORS.map((color) => (
                    <button
                      key={color.id}
                      type="button"
                      onClick={() => selectColor(color.id)}
                      aria-pressed={style.color === color.id}
                      className={`flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs transition-colors ${
                        style.color === color.id
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-border text-text hover:bg-surface-2'
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className="h-3 w-3 rounded-full border border-black/10"
                        style={{ backgroundColor: `#${color.accent}` }}
                      />
                      {color.label}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={!exportReady || docxState === 'working'}
                    onClick={handleDownloadLetterDocx}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs text-text transition-colors hover:bg-surface-2 disabled:opacity-50"
                  >
                    {docxState === 'working' ? 'Building…' : 'Download .docx'}
                  </button>
                  <button
                    type="button"
                    disabled={!exportReady}
                    onClick={handlePrintLetter}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs text-text transition-colors hover:bg-surface-2 disabled:opacity-50"
                  >
                    Print / Save PDF
                  </button>
                  {docxState === 'done' && <span className="text-xs text-success">Downloaded.</span>}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-sm text-text transition-colors hover:bg-surface-2"
              >
                {copyState === 'copied' && <IconCheck className="h-4 w-4 text-success" />}
                {copyState === 'copied' ? 'Copied' : 'Copy'}
              </button>
              <button
                type="button"
                onClick={generate}
                className="rounded-lg border border-border px-4 py-2 text-sm text-text-dim transition-colors hover:text-text"
              >
                Regenerate
              </button>
              <button
                type="button"
                disabled={sending}
                onClick={handleMarkSent}
                className="ml-auto rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {sending ? 'Marking…' : 'Mark sent'}
              </button>
            </div>
            <p className="text-xs text-text-dim">
              Fieldwork never sends this for you — copy it into your own email/LinkedIn, send it
              yourself, then click Mark sent.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
