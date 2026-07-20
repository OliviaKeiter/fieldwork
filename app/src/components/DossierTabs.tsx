import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { IconChevronDown, IconEdit } from './icons';
import {
  getApplication,
  insertEvent,
  recordRejection,
  setStatus,
  updateApplicationDetails,
} from '../lib/applications';
import { listEvents, listJds, listContactsForApp, listPrepDocs, listDraftsForApp } from '../lib/dossier';
import { dateInputToDate, formatDate, localDateString } from '../lib/dateUtils';
import { STATUS_LABEL, STATUS_ORDER } from '../lib/pipeline';
import { RESUME_EVENT_PREFIX, parseResumeEventBody } from '../lib/resume';
import ResumeStudio from './ResumeStudio';
import OrbitBadge from './OrbitBadge';
import ContactForm from './ContactForm';
import PrepPanel from './PrepPanel';
import DraftPanel from './DraftPanel';
import HistoryPanel from './HistoryPanel';
import { GradeBadge, GRADE_META } from './VerdictCardView';
import type {
  FwApplication,
  FwContact,
  FwDraft,
  FwEvent,
  FwEventType,
  FwJd,
  FwPrepDoc,
  FwStatus,
} from '../lib/types';

type Tab = 'overview' | 'jd' | 'resume' | 'contacts' | 'prep' | 'history';
type LoadState = 'loading' | 'ready' | 'error' | 'not_found';

const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Timeline' },
  { key: 'jd', label: 'Job description' },
  { key: 'resume', label: 'Resume' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'prep', label: 'Prep' },
  { key: 'history', label: 'History' },
];

const TAB_KEYS = TABS.map((t) => t.key);

function isTab(value: string | null): value is Tab {
  return value !== null && (TAB_KEYS as string[]).includes(value);
}

/** The open tab lives in the URL (`?id=…&tab=resume`) rather than in React state
 *  alone. Three things fall out of that for free: reloading keeps your place, the
 *  back button steps through tabs instead of leaving the dossier, and a tab is a
 *  link you can send yourself. */
function readTabFromUrl(): Tab {
  if (typeof window === 'undefined') return 'overview';
  const value = new URLSearchParams(window.location.search).get('tab');
  return isTab(value) ? value : 'overview';
}

const EVENT_TYPES: FwEventType[] = [
  'applied',
  'screen',
  'round',
  'debrief',
  'rejection',
  'nudge',
  'thank_you',
  'note',
  'offer',
];

/** Event types that imply a pipeline stage: logging one auto-moves the application there,
 * FORWARD only (per fw_status enum order — a late-logged screen never downgrades a card
 * that's already interviewing). 'rejection' is absent because it takes its own path in
 * handleLogEvent: recordRejection(), so the lessons log still gets a row (the event note
 * doubles as the company's stated reason). */
const EVENT_STATUS_TARGET: Partial<Record<FwEventType, FwStatus>> = {
  applied: 'applied',
  screen: 'phone_screen',
  round: 'interviewing',
  offer: 'offer',
};

interface Props {
  applicationId: string;
}

/** "$240k – $260k" style compensation label from the stored min/max. */
function formatComp(min: number | null, max: number | null): string | null {
  const fmt = (n: number) => (n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`);
  if (min != null && max != null) return min === max ? fmt(min) : `${fmt(min)} – ${fmt(max)}`;
  if (min != null) return `${fmt(min)}+`;
  if (max != null) return `up to ${fmt(max)}`;
  return null;
}

export default function DossierTabs({ applicationId }: Props) {
  const [state, setState] = useState<LoadState>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [tab, setTabState] = useState<Tab>('overview');
  const [jdExpanded, setJdExpanded] = useState<Record<string, boolean>>({});

  /* Server-render is always 'overview' (no URL there), so adopt the real tab on
     mount, and follow the back/forward buttons after that. */
  useEffect(() => {
    setTabState(readTabFromUrl());
    const onPop = () => setTabState(readTabFromUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const setTab = useCallback((next: Tab) => {
    setTabState(next);
    const url = new URL(window.location.href);
    /* Overview is the default, so it stays out of the URL. */
    if (next === 'overview') url.searchParams.delete('tab');
    else url.searchParams.set('tab', next);
    window.history.pushState({}, '', url);
  }, []);

  const [application, setApplication] = useState<FwApplication | null>(null);
  const [events, setEvents] = useState<FwEvent[]>([]);
  const [jds, setJds] = useState<FwJd[]>([]);
  const [contacts, setContacts] = useState<FwContact[]>([]);
  const [prepDocs, setPrepDocs] = useState<FwPrepDoc[]>([]);
  const [drafts, setDrafts] = useState<FwDraft[]>([]);

  const [logType, setLogType] = useState<FwEventType>('note');
  // Local calendar date — toISOString() would give the UTC date (tomorrow, in the evening).
  const [logDate, setLogDate] = useState(() => localDateString());
  const [logBody, setLogBody] = useState('');
  const [logging, setLogging] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [rejectionHint, setRejectionHint] = useState(false);
  const [showCoverLetterDraft, setShowCoverLetterDraft] = useState(false);
  const [showContactForm, setShowContactForm] = useState(false);

  // Inline company/title editing: intake extraction gets these wrong sometimes (a blank
  // field files as "(unknown)"), and everything downstream — dedupe, drafts, file names —
  // keys off them, so they are correctable right where you notice the mistake.
  const [editingHeader, setEditingHeader] = useState(false);
  const [editCompany, setEditCompany] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [savingHeader, setSavingHeader] = useState(false);
  const [headerError, setHeaderError] = useState<string | null>(null);

  function startHeaderEdit() {
    if (!application) return;
    setEditCompany(application.company === '(unknown)' ? '' : application.company);
    setEditTitle(application.title ?? '');
    setHeaderError(null);
    setEditingHeader(true);
  }

  async function saveHeaderEdit(e: FormEvent) {
    e.preventDefault();
    if (!editCompany.trim()) {
      setHeaderError('Company name cannot be empty.');
      return;
    }
    setSavingHeader(true);
    setHeaderError(null);
    try {
      await updateApplicationDetails(applicationId, {
        company: editCompany.trim(),
        title: editTitle.trim() || null,
      });
      setEditingHeader(false);
      await load();
    } catch (err) {
      setHeaderError(err instanceof Error ? err.message : 'Could not save the changes.');
    } finally {
      setSavingHeader(false);
    }
  }

  // Application questions: poster-written free-text prompts on the application form.
  // Each question runs the standard draft flow (generate → edit → copy → saved fw_drafts
  // row) with the question passed as extra_context; repeat for as many questions as the
  // application has, each saving its own row.
  const [questionText, setQuestionText] = useState('');
  const [showQuestionDraft, setShowQuestionDraft] = useState(false);

  // Header "Build resume" lifts the trigger: it flips to the Resume tab with a pending
  // request that ResumeStudio consumes, so there is exactly one build code path.
  const [pendingResumeBuild, setPendingResumeBuild] = useState(false);
  const [resumeBuilding, setResumeBuilding] = useState(false);

  function handleHeaderBuildResume() {
    if (resumeBuilding) return;
    setTab('resume');
    setPendingResumeBuild(true);
  }

  const load = useCallback(async () => {
    // First load shows the loading screen; later calls are background refreshes that must
    // NOT unmount the tab panels — ResumeStudio keeps in-progress edits in local state.
    setState((s) => (s === 'ready' ? s : 'loading'));
    try {
      const app = await getApplication(applicationId);
      if (!app) {
        setState('not_found');
        return;
      }
      const [ev, jd, ct, prep, dr] = await Promise.all([
        listEvents(applicationId),
        listJds(applicationId),
        listContactsForApp(applicationId),
        listPrepDocs(applicationId),
        listDraftsForApp(applicationId),
      ]);
      setApplication(app);
      setEvents(ev);
      setJds(jd);
      setContacts(ct);
      setPrepDocs(prep);
      setDrafts(dr);
      setState('ready');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to load this dossier.');
      setState('error');
    }
  }, [applicationId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleLogEvent(e: FormEvent) {
    e.preventDefault();
    setLogging(true);
    setLogError(null);
    setRejectionHint(false);
    try {
      // dateInputToDate: today keeps the current local time; other days anchor at local
      // noon, so "2026-07-13" never stores as UTC midnight (= JUL 12 evening local).
      await insertEvent(applicationId, logType, logBody || null, dateInputToDate(logDate));

      // Event-driven pipeline move: same setStatus path the Pipeline drag uses (status
      // update + status_change event), forward-only per the fw_status enum order.
      const target = application ? EVENT_STATUS_TARGET[logType] : undefined;
      if (
        application &&
        target &&
        STATUS_ORDER.indexOf(target) > STATUS_ORDER.indexOf(application.status)
      ) {
        await setStatus(applicationId, target, application.status);
      }
      // Rejection moves the card too — same write shape as the Pipeline drag-to-reject
      // (status + status_change event + fw_lessons row), with the note as the stated reason.
      if (logType === 'rejection' && application && application.status !== 'rejected') {
        await recordRejection(application, logBody.trim() || null);
      }
      if (logType === 'rejection') setRejectionHint(true);

      setLogBody('');
      await load();
    } catch (err) {
      setLogError(err instanceof Error ? err.message : 'Could not log that event.');
    } finally {
      setLogging(false);
    }
  }

  /* Counts on the tabs, so you can see there are two prep docs without opening
     Prep. Zero renders as no badge rather than a "0" chip. */
  const TAB_COUNTS: Record<Tab, number> = {
    overview: events.length,
    jd: jds.length,
    resume: 0,
    contacts: contacts.length,
    prep: prepDocs.length,
    history: drafts.length,
  };

  if (state === 'loading') {
    return <p className="text-sm text-text-dim">Loading dossier…</p>;
  }

  if (state === 'not_found') {
    return (
      <div className="rounded-xl border border-border bg-surface p-6 text-sm text-text-dim">
        No application found with that id.
      </div>
    );
  }

  if (state === 'error' || !application) {
    return (
      <div className="rounded-xl border border-danger/40 bg-surface p-6 text-sm text-danger">
        {errorMessage ?? 'Something went wrong loading this dossier.'}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-text-dim">
            {STATUS_LABEL[application.status as FwStatus] ?? application.status}
          </p>
          {editingHeader ? (
            <form onSubmit={saveHeaderEdit} className="mt-1 flex max-w-md flex-col gap-2">
              <input
                value={editCompany}
                onChange={(e) => setEditCompany(e.target.value)}
                placeholder="Company"
                autoFocus
                aria-label="Company"
                className="rounded-lg border border-border bg-bg px-3 py-1.5 text-lg font-semibold text-text outline-none focus:border-accent"
              />
              <input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                placeholder="Role title"
                aria-label="Role title"
                className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text outline-none focus:border-accent"
              />
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={savingHeader}
                  className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {savingHeader ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingHeader(false)}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-dim transition-colors hover:text-text"
                >
                  Cancel
                </button>
                {headerError && <span className="text-xs text-danger">{headerError}</span>}
              </div>
            </form>
          ) : (
            <>
              <div className="group flex items-center gap-2">
                <h1 className="mt-1 truncate text-xl font-semibold text-text">
                  {application.company}
                </h1>
                <button
                  type="button"
                  onClick={startHeaderEdit}
                  aria-label="Edit company and title"
                  title="Edit company and title"
                  className="mt-1 rounded-lg p-1 text-text-dim opacity-0 transition-opacity hover:bg-surface-2 hover:text-text focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <IconEdit className="h-4 w-4" />
                </button>
              </div>
              <p className="text-sm text-text-dim">{application.title ?? 'Untitled role'}</p>
            </>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <OrbitBadge status={application.status} appId={application.id} />
            <button
              type="button"
              onClick={() => setShowCoverLetterDraft(true)}
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-text transition-colors hover:bg-surface-2"
            >
              Draft cover letter
            </button>
            <button
              type="button"
              disabled={resumeBuilding}
              onClick={handleHeaderBuildResume}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {resumeBuilding ? 'Building…' : 'Build resume'}
            </button>
          </div>
          {/* The scorecard grade, same badge the JD tab renders — surfaced here so a card's
              grade is visible the moment the dossier opens, on every tab. */}
          {application.grade && (
            <span className="flex items-center gap-2">
              <GradeBadge grade={application.grade} small />
              <span className="text-xs text-text-dim">{GRADE_META[application.grade].gloss}</span>
            </span>
          )}
        </div>
      </div>

      {/* Sticky, because the dossier scrolls long and losing the tab bar means
          scrolling back up to change tabs. */}
      <div
        role="tablist"
        aria-label="Dossier sections"
        className="sticky top-0 z-20 -mx-1 flex gap-1 overflow-x-auto border-b border-border bg-bg/95 px-1 backdrop-blur"
      >
        {TABS.map((t) => {
          const selected = tab === t.key;
          const count = TAB_COUNTS[t.key];
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setTab(t.key)}
              className={`flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm transition-colors ${
                selected
                  ? 'border-accent font-medium text-text'
                  : 'border-transparent text-text-dim hover:border-border hover:text-text'
              }`}
            >
              {t.label}
              {count > 0 && (
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[0.65rem] font-medium leading-none ${
                    selected ? 'bg-accent/15 text-accent' : 'bg-surface-2 text-text-dim'
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {tab === 'overview' && (
        <div className="flex flex-col gap-6">
          <form
            onSubmit={handleLogEvent}
            className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-surface p-4"
          >
            <label className="flex flex-col gap-1 text-xs text-text-dim">
              Type
              <select
                value={logType}
                onChange={(e) => setLogType(e.target.value as FwEventType)}
                className="rounded-lg border border-border bg-bg px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
              >
                {EVENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-text-dim">
              Date
              <input
                type="date"
                value={logDate}
                onChange={(e) => setLogDate(e.target.value)}
                className="rounded-lg border border-border bg-bg px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
              />
            </label>
            <label className="flex flex-1 flex-col gap-1 text-xs text-text-dim">
              Note
              <input
                value={logBody}
                onChange={(e) => setLogBody(e.target.value)}
                placeholder="Optional detail…"
                className="rounded-lg border border-border bg-bg px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
              />
            </label>
            <button
              type="submit"
              disabled={logging}
              className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {logging ? 'Logging…' : 'Log event'}
            </button>
            {logError && <p className="w-full text-sm text-danger">{logError}</p>}
            {rejectionHint && (
              <p className="w-full text-xs text-text-dim">
                Rejection logged — the card moved to Rejected and a lessons-log entry was
                added (the note is stored as the company's stated reason).
              </p>
            )}
          </form>

          <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
            <div>
              <h3 className="text-sm font-medium text-text">Application questions</h3>
              <p className="mt-0.5 text-xs text-text-dim">
                Paste a free-text question from the application form and draft an answer from
                your career record plus this role's context. Repeat for each question: every
                answer saves as its own draft.
              </p>
            </div>
            <p className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-text">
              Every AI action reads the career record; nothing generated may exceed it. Review
              and edit the answer before pasting it into the application.
            </p>
            <textarea
              value={questionText}
              onChange={(e) => setQuestionText(e.target.value)}
              rows={3}
              placeholder="Paste the application question…"
              className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent"
            />
            <button
              type="button"
              disabled={!questionText.trim()}
              onClick={() => setShowQuestionDraft(true)}
              className="self-start rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              Draft answer
            </button>
          </section>

          {events.length === 0 ? (
            <p className="text-sm text-text-dim">No events logged yet for this application.</p>
          ) : (
            <ol className="flex flex-col gap-3">
              {events.map((ev) => (
                <li
                  key={ev.id}
                  className="rounded-lg border border-border bg-surface p-3 text-sm"
                >
                  <p className="text-xs uppercase tracking-wide text-text-dim">
                    {formatDate(ev.occurred_at)} · {ev.type}
                  </p>
                  {ev.body &&
                    (() => {
                      // Resume-export notes carry the full resume text as a snapshot; the
                      // timeline shows only the "Resume built: <file>" first line (the full
                      // snapshot lives in the History tab). Everything else renders in full.
                      const resume = parseResumeEventBody(ev.body);
                      return (
                        <p className="mt-1 whitespace-pre-wrap text-text">
                          {resume ? `${RESUME_EVENT_PREFIX}${resume.filename}` : ev.body}
                        </p>
                      );
                    })()}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {tab === 'jd' && (
        <div className="flex flex-col gap-4">
          {jds.length === 0 ? (
            <p className="text-sm text-text-dim">No JD on file for this application.</p>
          ) : (
            jds.map((jd) => (
              <div key={jd.id} className="rounded-xl border border-border bg-surface p-4">
                {/* Scannable facts grid — the chunk of raw JD text is collapsed below. */}
                <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-text-dim">Role title</dt>
                    <dd className="mt-0.5 text-sm text-text">{application?.title ?? 'Untitled role'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-text-dim">Comp</dt>
                    <dd className="mt-0.5 text-sm text-text">
                      {formatComp(application?.comp_min ?? null, application?.comp_max ?? null) ?? 'Not posted'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-text-dim">Location</dt>
                    <dd className="mt-0.5 text-sm capitalize text-text">
                      {application?.remote_type ?? 'Unknown'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-text-dim">Grade</dt>
                    <dd className="mt-0.5 text-sm text-text">
                      {application?.grade ? (
                        <span className="flex items-center gap-2">
                          <GradeBadge grade={application.grade} small />
                          <span className="text-text-dim">{GRADE_META[application.grade].gloss}</span>
                        </span>
                      ) : (
                        'Not scored'
                      )}
                    </dd>
                  </div>
                  {jd.url && (
                    <div className="sm:col-span-2">
                      <dt className="text-xs uppercase tracking-wide text-text-dim">Posting</dt>
                      <dd className="mt-0.5">
                        <a
                          href={jd.url}
                          target="_blank"
                          rel="noreferrer"
                          className="break-all text-sm text-accent hover:underline"
                        >
                          {jd.url}
                        </a>
                        {jd.live_checked_at && (
                          <span className="ml-2 text-xs text-text-dim">
                            checked {formatDate(jd.live_checked_at)}
                          </span>
                        )}
                      </dd>
                    </div>
                  )}
                </dl>

                {jd.pain_line && (
                  <div className="mt-4">
                    <p className="text-xs uppercase tracking-wide text-text-dim">Fit</p>
                    <p className="mt-1 text-sm italic text-text-dim">"{jd.pain_line}"</p>
                  </div>
                )}

                {Array.isArray(jd.gaps) && jd.gaps.length > 0 && (
                  <div className="mt-4">
                    <p className="text-xs uppercase tracking-wide text-text-dim">Gaps</p>
                    <ul className="mt-1 list-inside list-disc text-sm text-text">
                      {(jd.gaps as unknown[]).map((g, i) => (
                        <li key={i}>{String(g)}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {jd.raw_text && (
                  <div className="mt-4 border-t border-border pt-3">
                    <button
                      type="button"
                      onClick={() => setJdExpanded((prev) => ({ ...prev, [jd.id]: !prev[jd.id] }))}
                      aria-expanded={!!jdExpanded[jd.id]}
                      className="inline-flex items-center gap-1.5 text-sm font-medium text-text hover:text-accent"
                    >
                      <IconChevronDown
                        className={`h-4 w-4 transition-transform ${jdExpanded[jd.id] ? '' : '-rotate-90'}`}
                      />
                      Full job description
                    </button>
                    {jdExpanded[jd.id] && (
                      <p className="mt-2 whitespace-pre-wrap text-sm text-text">{jd.raw_text}</p>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* Hidden rather than unmounted when another tab is open: a built (or half-edited)
          resume must survive hopping to the JD tab and back. The display:none wrapper also
          keeps the studio's print-only markup out of Ctrl+P on other tabs. */}
      <div className={tab === 'resume' ? undefined : 'hidden'}>
        <ResumeStudio
          application={application}
          onBuilt={load}
          autoBuild={pendingResumeBuild}
          onAutoBuildConsumed={() => setPendingResumeBuild(false)}
          onBuildingChange={setResumeBuilding}
        />
      </div>

      {tab === 'contacts' && (
        <div className="flex flex-col gap-3">
          <div>
            <button
              type="button"
              onClick={() => setShowContactForm(true)}
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-text transition-colors hover:bg-surface-2"
            >
              + Add contact
            </button>
          </div>
          {contacts.length === 0 ? (
            <p className="text-sm text-text-dim">
              No contacts linked to this application yet.
            </p>
          ) : (
            contacts.map((c) => (
              <div key={c.id} className="rounded-xl border border-border bg-surface p-4 text-sm">
                <p className="font-medium text-text">{c.name}</p>
                <p className="text-text-dim">{c.role_title ?? '—'}</p>
                {(c.email || c.linkedin) && (
                  <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-text-dim">
                    {c.email && (
                      <a href={`mailto:${c.email}`} className="hover:text-text">
                        {c.email}
                      </a>
                    )}
                    {c.linkedin && (
                      <a
                        href={c.linkedin.startsWith('http') ? c.linkedin : `https://${c.linkedin}`}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:text-text"
                      >
                        LinkedIn
                      </a>
                    )}
                  </p>
                )}
                <p className="mt-1 text-xs text-text-dim capitalize">Warmth: {c.warmth}</p>
              </div>
            ))
          )}
          {showContactForm && (
            <ContactForm
              applicationId={applicationId}
              defaultCompany={application.company}
              onClose={() => setShowContactForm(false)}
              onSaved={() => {
                setShowContactForm(false);
                load();
              }}
            />
          )}
        </div>
      )}

      {tab === 'prep' && (
        <PrepPanel applicationId={applicationId} prepDocs={prepDocs} onRefresh={load} />
      )}

      {tab === 'history' && (
        <HistoryPanel
          application={application}
          drafts={drafts}
          prepDocs={prepDocs}
          events={events}
          onOpenTab={setTab}
        />
      )}

      {showQuestionDraft && (
        <DraftPanel
          type="application_question"
          context={{ application_id: applicationId, extra_context: questionText.trim() }}
          subjectLabel={`Application question: ${application.company}`}
          bodyPrefix={`Q: ${questionText.trim()}\n\n`}
          onClose={() => {
            setShowQuestionDraft(false);
            setQuestionText('');
            // The panel logged "drafted" (and possibly "sent") events while open — a
            // background refresh (no loading flash) puts them on the Timeline and flips
            // the History chip to Sent without a reload. Covers Mark sent too, which
            // closes the panel.
            void load();
          }}
        />
      )}

      {showCoverLetterDraft && (
        <DraftPanel
          type="cover_letter"
          context={{ application_id: applicationId }}
          subjectLabel={`Cover letter — ${application.company}`}
          onClose={() => {
            setShowCoverLetterDraft(false);
            void load();
          }}
        />
      )}
    </div>
  );
}
