import { useState, type CSSProperties, type ReactNode } from 'react';
import { IconCheck } from './icons';
import { formatDate } from '../lib/dateUtils';
import { parseResumeEventBody } from '../lib/resume';
import type { FwApplication, FwDraft, FwDraftType, FwEvent, FwPrepDoc } from '../lib/types';

const DRAFT_TYPE_LABEL: Record<FwDraftType, string> = {
  hello: 'Hello',
  nudge: 'Nudge',
  thank_you: 'Thank-you',
  stay_in_touch: 'Stay in touch',
  cover_letter: 'Cover letter',
  application_question: 'Application question',
};

interface Props {
  application: FwApplication;
  drafts: FwDraft[];
  prepDocs: FwPrepDoc[];
  events: FwEvent[];
  /** Jump to another dossier tab (Resume / Prep) from a history entry. */
  onOpenTab: (tab: 'resume' | 'prep') => void;
}

type Entry =
  | { kind: 'draft'; id: string; date: string; draft: FwDraft }
  // One per exported resume version — carries the full readable text snapshot.
  | { kind: 'resume'; id: string; date: string; filename: string; snapshot: string }
  // Fallback for resumes built before per-export snapshots existed (latest content only).
  | { kind: 'resumeLegacy'; id: string; date: string; app: FwApplication }
  | { kind: 'prep'; id: string; date: string; doc: FwPrepDoc };

/** Two-line collapse without the line-clamp plugin. */
const clampStyle: CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
};

function Chip({ children, tone = 'dim' }: { children: ReactNode; tone?: 'dim' | 'accent' | 'success' }) {
  const toneClass =
    tone === 'accent'
      ? 'border-accent/40 bg-accent/10 text-accent'
      : tone === 'success'
        ? 'border-success/40 bg-success/10 text-success'
        : 'border-border bg-bg text-text-dim';
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs ${toneClass}`}>{children}</span>
  );
}

/** History tab: every saved artifact for this application, newest first — drafts and
 * answers with their full bodies, persisted resume builds, and links to prep docs. The
 * timeline stays terse; the actual content lives here. */
export default function HistoryPanel({ application, drafts, prepDocs, events, onOpenTab }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function copyText(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
    } catch {
      // Clipboard unavailable — the expanded body is selectable by hand.
    }
  }

  // Each resume export writes a timeline note carrying the full readable text, so every
  // version stays viewable here — newest first, alongside drafts and prep docs.
  const resumeSnapshots = events
    .map((ev) => ({ ev, parsed: parseResumeEventBody(ev.body) }))
    .filter((x): x is { ev: FwEvent; parsed: { filename: string; snapshot: string } } =>
      x.parsed !== null
    );

  const entries: Entry[] = [
    ...drafts.map((d): Entry => ({ kind: 'draft', id: `draft-${d.id}`, date: d.created_at, draft: d })),
    ...prepDocs.map((p): Entry => ({ kind: 'prep', id: `prep-${p.id}`, date: p.created_at, doc: p })),
    ...resumeSnapshots.map(({ ev, parsed }): Entry => ({
      kind: 'resume',
      id: `resume-ev-${ev.id}`,
      date: ev.occurred_at,
      filename: parsed.filename,
      snapshot: parsed.snapshot,
    })),
  ];

  // Legacy fallback: a persisted resume with no snapshot event (built before snapshots).
  if (resumeSnapshots.length === 0 && (application.resume_content || application.resume_filename)) {
    entries.push({
      kind: 'resumeLegacy',
      id: `resume-${application.id}`,
      date: application.updated_at,
      app: application,
    });
  }

  entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  if (entries.length === 0) {
    return (
      <p className="text-sm text-text-dim">
        Nothing generated for this application yet — drafts, resumes, and answers will
        collect here.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {entries.map((entry) => {
        if (entry.kind === 'draft') {
          const d = entry.draft;
          const isOpen = expanded.has(entry.id);
          return (
            <div key={entry.id} className="rounded-xl border border-border bg-surface p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone="accent">{DRAFT_TYPE_LABEL[d.type]}</Chip>
                {d.status === 'sent' ? (
                  <Chip tone="success">Sent {d.sent_at ? formatDate(d.sent_at) : ''}</Chip>
                ) : (
                  <Chip>Draft</Chip>
                )}
                <span className="ml-auto text-xs text-text-dim">{formatDate(d.created_at)}</span>
              </div>
              <button
                type="button"
                onClick={() => toggle(entry.id)}
                aria-expanded={isOpen}
                className="mt-2 block w-full text-left"
              >
                <p
                  className="whitespace-pre-wrap text-sm text-text"
                  style={isOpen ? undefined : clampStyle}
                >
                  {d.body}
                </p>
              </button>
              <div className="mt-2 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => copyText(d.id, d.body)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1 text-xs text-text transition-colors hover:bg-surface-2"
                >
                  {copiedId === d.id && <IconCheck className="h-3.5 w-3.5 text-success" />}
                  {copiedId === d.id ? 'Copied' : 'Copy'}
                </button>
                <button
                  type="button"
                  onClick={() => toggle(entry.id)}
                  className="text-xs text-text-dim transition-colors hover:text-text"
                >
                  {isOpen ? 'Collapse' : 'Expand'}
                </button>
              </div>
            </div>
          );
        }

        if (entry.kind === 'resume') {
          const isOpen = expanded.has(entry.id);
          return (
            <div key={entry.id} className="rounded-xl border border-border bg-surface p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone="accent">Resume</Chip>
                <span className="text-sm font-medium text-text">{entry.filename || 'Resume build'}</span>
                <span className="ml-auto text-xs text-text-dim">Built {formatDate(entry.date)}</span>
              </div>
              {entry.snapshot ? (
                <>
                  <button
                    type="button"
                    onClick={() => toggle(entry.id)}
                    aria-expanded={isOpen}
                    className="mt-2 block w-full text-left"
                  >
                    <p
                      className="whitespace-pre-wrap text-sm text-text"
                      style={isOpen ? undefined : clampStyle}
                    >
                      {entry.snapshot}
                    </p>
                  </button>
                  <div className="mt-2 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => copyText(entry.id, entry.snapshot)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1 text-xs text-text transition-colors hover:bg-surface-2"
                    >
                      {copiedId === entry.id && <IconCheck className="h-3.5 w-3.5 text-success" />}
                      {copiedId === entry.id ? 'Copied' : 'Copy'}
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenTab('resume')}
                      className="rounded-lg border border-border px-3 py-1 text-xs text-text transition-colors hover:bg-surface-2"
                    >
                      Open in Resume tab
                    </button>
                    <button
                      type="button"
                      onClick={() => toggle(entry.id)}
                      className="text-xs text-text-dim transition-colors hover:text-text"
                    >
                      {isOpen ? 'Collapse' : 'Expand'}
                    </button>
                  </div>
                </>
              ) : (
                <p className="mt-2 text-xs text-text-dim">
                  Only the filename was recorded for this export.
                </p>
              )}
            </div>
          );
        }

        if (entry.kind === 'resumeLegacy') {
          const content = entry.app.resume_content;
          const isOpen = expanded.has(entry.id);
          return (
            <div key={entry.id} className="rounded-xl border border-border bg-surface p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone="accent">Resume</Chip>
                <span className="text-sm font-medium text-text">
                  {entry.app.resume_filename ?? 'Resume build'}
                </span>
                <span className="ml-auto text-xs text-text-dim">Built {formatDate(entry.date)}</span>
              </div>
              {content ? (
                <>
                  <button
                    type="button"
                    onClick={() => toggle(entry.id)}
                    aria-expanded={isOpen}
                    className="mt-2 block w-full text-left"
                  >
                    <p
                      className="text-sm text-text"
                      style={isOpen ? undefined : clampStyle}
                    >
                      {content.summary || 'No summary in this build.'}
                    </p>
                    {isOpen && (
                      <p className="mt-2 text-xs text-text-dim">
                        {content.experience.length} experience{' '}
                        {content.experience.length === 1 ? 'entry' : 'entries'} ·{' '}
                        {content.skills.length} skills · {content.education.length} education
                        {content.highlight?.items.length
                          ? ` · ${content.highlight.items.length} highlights`
                          : ''}
                      </p>
                    )}
                  </button>
                  <div className="mt-2 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => onOpenTab('resume')}
                      className="rounded-lg border border-border px-3 py-1 text-xs text-text transition-colors hover:bg-surface-2"
                    >
                      Open in Resume tab
                    </button>
                    <button
                      type="button"
                      onClick={() => toggle(entry.id)}
                      className="text-xs text-text-dim transition-colors hover:text-text"
                    >
                      {isOpen ? 'Collapse' : 'Expand'}
                    </button>
                  </div>
                </>
              ) : (
                <p className="mt-2 text-xs text-text-dim">
                  Built before content persistence — only the filename was recorded. Rebuild
                  from the Resume tab to save an editable copy.
                </p>
              )}
            </div>
          );
        }

        const doc = entry.doc;
        return (
          <div key={entry.id} className="rounded-xl border border-border bg-surface p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone="accent">Prep doc</Chip>
              <span className="text-sm text-text">{doc.round_type ?? 'Interview prep'}</span>
              <span className="ml-auto text-xs text-text-dim">{formatDate(doc.created_at)}</span>
            </div>
            <button
              type="button"
              onClick={() => onOpenTab('prep')}
              className="mt-2 rounded-lg border border-border px-3 py-1 text-xs text-text transition-colors hover:bg-surface-2"
            >
              Open in Prep tab
            </button>
          </div>
        );
      })}
    </div>
  );
}
