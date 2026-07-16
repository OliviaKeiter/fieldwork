import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { getTimingSettings, getWhimsyLevel, type WhimsyLevel } from '../lib/settings';
import {
  buildTodayView,
  type QueueItem,
  type TodayView,
  type UpcomingInterview,
} from '../lib/todayQueue';
import { autoGhost, snoozeNextAction } from '../lib/applications';
import { formatTime } from '../lib/dateUtils';
import DraftPanel from './DraftPanel';
import {
  IconMail,
  IconBell,
  IconClock,
  IconCalendar,
  IconArrowRight,
  type IconComponent,
} from './icons';
import type { FwApplication, FwEvent } from '../lib/types';

type LoadState = 'loading' | 'ready' | 'error';

const KIND_LABEL: Record<QueueItem['kind'], string> = {
  thank_you: 'Thank-you',
  nudge: 'Nudge',
  stale_to_apply: 'Still queued',
};

const KIND_ICON: Record<QueueItem['kind'], IconComponent> = {
  thank_you: IconMail,
  nudge: IconBell,
  stale_to_apply: IconClock,
};

/** The tinted square an item's icon sits in. One shape for every card on the
 *  page, so the eye can scan the column by icon alone. */
function IconChip({
  Icon,
  tone = 'dim',
}: {
  Icon: IconComponent;
  tone?: 'dim' | 'accent';
}) {
  return (
    <span
      aria-hidden="true"
      className={[
        'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
        tone === 'accent' ? 'bg-accent/15 text-accent' : 'bg-surface-2 text-text-dim',
      ].join(' ')}
    >
      <Icon className="h-[1.15rem] w-[1.15rem]" />
    </span>
  );
}

/** "Open dossier" with a nudge arrow. Repeated on every card here, so it is one
 *  component rather than three copies. */
function DossierLink({ id }: { id: string }) {
  return (
    <a
      href={`/company?id=${id}`}
      className="group mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
    >
      Open dossier
      <IconArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
    </a>
  );
}

async function fetchView(): Promise<{ view: TodayView; whimsy: WhimsyLevel }> {
  const [appsRes, eventsRes, timing, whimsy] = await Promise.all([
    supabase.from('fw_applications').select('*'),
    supabase.from('fw_events').select('*'),
    getTimingSettings(),
    getWhimsyLevel(),
  ]);
  if (appsRes.error) throw appsRes.error;
  if (eventsRes.error) throw eventsRes.error;
  return {
    view: buildTodayView(
      (appsRes.data ?? []) as FwApplication[],
      (eventsRes.data ?? []) as FwEvent[],
      timing
    ),
    whimsy,
  };
}

export default function TodayQueue() {
  const [state, setState] = useState<LoadState>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [view, setView] = useState<TodayView | null>(null);
  const [whimsy, setWhimsy] = useState<WhimsyLevel>('gentle');
  const [swept, setSwept] = useState<FwApplication[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [draftFor, setDraftFor] = useState<{
    application: FwApplication;
    type: 'nudge' | 'thank_you';
  } | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      let { view: next, whimsy: level } = await fetchView();

      // Anything past the silence threshold gets swept here rather than rendered as a
      // backlog. Sweeping flips them to a terminal status, so the re-read below cannot
      // hand back the same candidates and loop.
      if (next.ghostCandidates.length > 0) {
        const justSwept = await autoGhost(next.ghostCandidates);
        setSwept((prev) => [...prev, ...justSwept]);
        ({ view: next } = await fetchView());
      }

      setView(next);
      setWhimsy(level);
      setState('ready');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to load today.');
      setState('error');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSnooze(item: QueueItem, days: number) {
    setBusyId(item.application.id);
    try {
      await snoozeNextAction(item.application, days);
      await load();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not snooze that item.');
    } finally {
      setBusyId(null);
    }
  }

  if (state === 'loading') {
    return <p className="text-sm text-text-dim">Loading today…</p>;
  }

  if (state === 'error' || !view) {
    return (
      <div className="rounded-xl border border-danger/40 bg-surface p-6 text-sm text-danger">
        {errorMessage ?? 'Something went wrong loading today.'}
      </div>
    );
  }

  const { momentum, appliedToday, dueToday, dueTomorrow, upcoming } = view;
  const upcomingToday = upcoming.filter((u) => u.daysOut === 0);
  const upcomingTomorrow = upcoming.filter((u) => u.daysOut === 1);
  const upcomingAhead = upcoming.filter((u) => u.daysOut > 1);

  const nothingToday =
    dueToday.length === 0 && upcomingToday.length === 0 && appliedToday.length === 0;
  const nothingTomorrow = dueTomorrow.length === 0 && upcomingTomorrow.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <MomentumStrip momentum={momentum} whimsy={whimsy} />

      {appliedToday.length > 0 && <AppliedToday apps={appliedToday} />}

      <Section title="Today" count={dueToday.length + upcomingToday.length}>
        {upcomingToday.map((u) => (
          <InterviewCard key={u.event.id} item={u} />
        ))}
        {dueToday.map((item) => (
          <ActionCard
            key={`${item.kind}-${item.application.id}`}
            item={item}
            busy={busyId === item.application.id}
            onDraft={(type) => setDraftFor({ application: item.application, type })}
            onSnooze={() => handleSnooze(item, 3)}
          />
        ))}
        {nothingToday && (
          <EmptyLine text={
            whimsy === 'off'
              ? 'Nothing is due today.'
              : "Nothing's due today. The pipeline is quiet in the good way."
          } />
        )}
      </Section>

      <Section title="Tomorrow" count={dueTomorrow.length + upcomingTomorrow.length} dim>
        {upcomingTomorrow.map((u) => (
          <InterviewCard key={u.event.id} item={u} />
        ))}
        {dueTomorrow.map((item) => (
          <ActionCard
            key={`${item.kind}-${item.application.id}`}
            item={item}
            busy={busyId === item.application.id}
            onDraft={(type) => setDraftFor({ application: item.application, type })}
            onSnooze={() => handleSnooze(item, 3)}
            heads
          />
        ))}
        {nothingTomorrow && <EmptyLine text="Nothing lands tomorrow." />}
      </Section>

      {upcomingAhead.length > 0 && (
        <Section title="Ahead" count={upcomingAhead.length} dim>
          {upcomingAhead.map((u) => (
            <InterviewCard key={u.event.id} item={u} />
          ))}
        </Section>
      )}

      {swept.length > 0 && <SweptNotice apps={swept} />}

      {draftFor && (
        <DraftPanel
          type={draftFor.type}
          context={{ application_id: draftFor.application.id }}
          subjectLabel={`${draftFor.application.company} — ${draftFor.application.title ?? 'Role'}`}
          onClose={() => setDraftFor(null)}
          onSent={load}
        />
      )}
    </div>
  );
}

/** Observed counts only — every number here is something the pipeline actually did. */
function MomentumStrip({ momentum, whimsy }: { momentum: TodayView['momentum']; whimsy: WhimsyLevel }) {
  const stats = [
    { label: 'out today', value: momentum.appliedToday },
    { label: 'out this week', value: momentum.appliedThisWeek },
    { label: 'live', value: momentum.live },
    { label: 'replies in 7d', value: momentum.repliesThisWeek },
  ];
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap gap-x-8 gap-y-3">
        {stats.map((s) => (
          <div key={s.label}>
            <p className="text-2xl font-semibold text-text">{s.value}</p>
            <p className="text-xs text-text-dim">{s.label}</p>
          </div>
        ))}
      </div>
      {whimsy !== 'off' && momentum.appliedThisWeek > 0 && (
        <p className="mt-3 text-xs text-text-dim">
          {momentum.appliedThisWeek} application{momentum.appliedThisWeek === 1 ? '' : 's'} went out
          this week. That part is entirely up to you, and you did it.
        </p>
      )}
    </div>
  );
}

function AppliedToday({ apps }: { apps: FwApplication[] }) {
  return (
    <div className="rounded-xl border border-accent/30 bg-surface p-4">
      <p className="text-xs uppercase tracking-wide text-text-dim">
        Applied today · {apps.length}
      </p>
      <ul className="mt-2 flex flex-col gap-1">
        {apps.map((a) => (
          <li key={a.id} className="text-sm">
            <a href={`/company?id=${a.id}`} className="text-text hover:text-accent">
              <span className="font-medium">{a.company}</span>
              <span className="text-text-dim"> — {a.title ?? 'Role'}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Section({
  title,
  count,
  dim,
  children,
}: {
  title: string;
  count: number;
  dim?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h2
        className={`mb-2 text-xs font-medium uppercase tracking-wide ${
          dim ? 'text-text-dim' : 'text-text'
        }`}
      >
        {title}
        {count > 0 && <span className="ml-2 text-text-dim">{count}</span>}
      </h2>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

function EmptyLine({ text }: { text: string }) {
  return (
    <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-text-dim">
      {text}
    </p>
  );
}

function InterviewCard({ item }: { item: UpcomingInterview }) {
  const when =
    item.daysOut === 0
      ? `Today ${formatTime(item.event.scheduled_at as string)}`
      : item.daysOut === 1
        ? `Tomorrow ${formatTime(item.event.scheduled_at as string)}`
        : `In ${item.daysOut} days · ${formatTime(item.event.scheduled_at as string)}`;

  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-accent/40 bg-surface p-4">
      <div className="flex gap-3">
        <IconChip Icon={IconCalendar} tone="accent" />
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">{when}</p>
          <p className="mt-0.5 font-medium text-text">
            {item.event.type === 'screen' ? 'Screen' : item.event.type === 'round' ? 'Interview' : 'Debrief'}{' '}
            — {item.application.company}
          </p>
          <p className="mt-0.5 text-sm text-text-dim">{item.application.title ?? 'Role'}</p>
          <DossierLink id={item.application.id} />
        </div>
      </div>
    </div>
  );
}

function ActionCard({
  item,
  busy,
  heads,
  onDraft,
  onSnooze,
}: {
  item: QueueItem;
  busy: boolean;
  heads?: boolean;
  onDraft: (type: 'nudge' | 'thank_you') => void;
  onSnooze: () => void;
}) {
  return (
    <div
      className={`flex items-start justify-between gap-4 rounded-xl border border-border bg-surface p-4 ${
        heads ? 'opacity-70' : ''
      }`}
    >
      <div className="flex min-w-0 gap-3">
        <IconChip Icon={KIND_ICON[item.kind]} />
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-dim">
            {KIND_LABEL[item.kind]}
          </p>
          <p className="mt-0.5 font-medium text-text">{item.headline}</p>
          <p className="mt-0.5 text-sm text-text-dim">{item.detail}</p>
          <DossierLink id={item.application.id} />
        </div>
      </div>

      <div className="flex shrink-0 flex-col gap-2">
        {(item.kind === 'nudge' || item.kind === 'stale_to_apply') && (
          <button
            type="button"
            onClick={() => onDraft('nudge')}
            className="rounded-lg bg-accent px-3 py-1.5 text-center text-xs font-medium text-bg transition-opacity hover:opacity-90"
          >
            Draft nudge
          </button>
        )}
        {item.kind === 'thank_you' && (
          <button
            type="button"
            onClick={() => onDraft('thank_you')}
            className="rounded-lg bg-accent px-3 py-1.5 text-center text-xs font-medium text-bg transition-opacity hover:opacity-90"
          >
            Draft thank-you
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={onSnooze}
          className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-dim transition-colors hover:text-text disabled:opacity-50"
        >
          Snooze 3d
        </button>
      </div>
    </div>
  );
}

/** Reports the auto-ghost sweep after the fact. Rejection-adjacent, so it stays plain —
 * no whimsy, no consolation, just what happened and where it went. */
function SweptNotice({ apps }: { apps: FwApplication[] }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <p className="text-sm text-text-dim">
        Moved {apps.length} application{apps.length === 1 ? '' : 's'} to ghosted — no contact past
        your threshold. {apps.length === 1 ? 'It is' : 'They are'} still in Pipeline and still
        counted in Insights.
      </p>
      <p className="mt-1 text-xs text-text-dim">
        {apps
          .slice(0, 6)
          .map((a) => a.company)
          .join(', ')}
        {apps.length > 6 ? `, +${apps.length - 6} more` : ''}
      </p>
    </div>
  );
}
