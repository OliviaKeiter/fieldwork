import type { FwApplication, FwEvent } from './types';
import type { TimingSettings } from './settings';
import { calendarDaysUntil, daysBetween, hoursBetween, parseDate } from './dateUtils';

export type QueueItemKind = 'thank_you' | 'nudge' | 'stale_to_apply';

export interface QueueItem {
  kind: QueueItemKind;
  application: FwApplication;
  headline: string;
  detail: string;
}

export interface UpcomingInterview {
  application: FwApplication;
  event: FwEvent;
  /** 0 = today, 1 = tomorrow, n = n calendar days out. */
  daysOut: number;
}

/** Counts behind the momentum strip. Every number is observed from the pipeline — nothing
 * here is encouragement the data doesn't support. */
export interface Momentum {
  appliedToday: number;
  appliedThisWeek: number;
  /** Open applications: sourced or in flight, excluding everything terminal. */
  live: number;
  /** Screens/rounds/offers logged in the last 7 days — the "it is working" signal. */
  repliesThisWeek: number;
}

export interface TodayView {
  appliedToday: FwApplication[];
  dueToday: QueueItem[];
  dueTomorrow: QueueItem[];
  /** Booked interviews from now forward, soonest first. */
  upcoming: UpcomingInterview[];
  /** Active applications past the silence threshold. The caller sweeps these to 'ghosted'
   * (see autoGhost in applications.ts) — buildTodayView is pure and writes nothing. */
  ghostCandidates: FwApplication[];
  momentum: Momentum;
}

const TERMINAL_STATUSES = new Set(['rejected', 'withdrawn', 'accepted', 'ghosted', 'passed']);
const ACTIVE_INTERVIEW_STATUSES = new Set([
  'applied',
  'phone_screen',
  'interviewing',
  'final_round',
]);
const THANK_YOU_EVENT_TYPES = new Set(['screen', 'round', 'debrief']);
const REPLY_EVENT_TYPES = new Set(['screen', 'round', 'offer']);

/** True once an event has actually happened. An event carrying a future scheduled_at is
 * booked, not done — it must not trigger a thank-you for an interview that has not
 * occurred yet. Events with no scheduled_at are historical and always count as happened. */
function hasOccurred(ev: FwEvent, now: Date): boolean {
  if (!ev.scheduled_at) return true;
  return new Date(ev.scheduled_at).getTime() <= now.getTime();
}

/** The instant an event actually took place: its booked time when known, else the logged
 * calendar date. Using scheduled_at gives thank-you timing real hours to count from
 * instead of midnight on the day it was written down. */
function occurredInstant(ev: FwEvent): Date {
  return ev.scheduled_at ? new Date(ev.scheduled_at) : parseDate(ev.occurred_at);
}

/** Last real-world contact on an application: the most recent of its newest event and its
 * apply date, falling back to when the row was created.
 *
 * The max() matters both ways. created_at is only a fallback because it is the date the row
 * was *imported* — for a backfilled application it can be far newer than the apply date, and
 * preferring it would hide months of genuine silence. Conversely date_applied can be newer
 * than an event (a note logged while sourcing, then applied later), so the newest event
 * alone is not enough either. */
function lastContactDate(app: FwApplication, newestEvent: FwEvent | undefined): Date {
  const candidates: Date[] = [];
  if (newestEvent) candidates.push(parseDate(newestEvent.occurred_at));
  if (app.date_applied) candidates.push(parseDate(app.date_applied));
  if (candidates.length === 0) return parseDate(app.created_at);
  return new Date(Math.max(...candidates.map((d) => d.getTime())));
}

/** Builds the forward-looking Today view from live applications + events + the user's own
 * timing rules (never hardcoded — always passed in from `fw_settings`).
 *
 * Today answers "what is in front of me": what went out today, what needs me today and
 * tomorrow, what is on the calendar. Silence is not on that list — applications past the
 * threshold are returned as ghostCandidates for the caller to sweep, not rendered as a
 * backlog to scroll past.
 *
 * Pure function so it's easy to test and reason about; all Supabase I/O happens in the
 * caller. */
export function buildTodayView(
  applications: FwApplication[],
  events: FwEvent[],
  timing: TimingSettings
): TodayView {
  const now = new Date();

  const eventsByApp = new Map<string, FwEvent[]>();
  for (const ev of events) {
    const list = eventsByApp.get(ev.application_id) ?? [];
    list.push(ev);
    eventsByApp.set(ev.application_id, list);
  }
  for (const list of eventsByApp.values()) {
    list.sort((a, b) => parseDate(b.occurred_at).getTime() - parseDate(a.occurred_at).getTime());
  }

  const appliedToday: FwApplication[] = [];
  const dueToday: QueueItem[] = [];
  const dueTomorrow: QueueItem[] = [];
  const upcoming: UpcomingInterview[] = [];
  const ghostCandidates: FwApplication[] = [];

  let appliedThisWeek = 0;
  let live = 0;
  let repliesThisWeek = 0;

  for (const app of applications) {
    const appEvents = eventsByApp.get(app.id) ?? [];

    // --- Momentum (counted across every application, terminal or not) -------------------
    if (app.date_applied) {
      const daysSinceApplied = calendarDaysUntil(parseDate(app.date_applied), now);
      if (daysSinceApplied === 0) appliedToday.push(app);
      if (daysSinceApplied > -7 && daysSinceApplied <= 0) appliedThisWeek++;
    }
    for (const ev of appEvents) {
      if (!REPLY_EVENT_TYPES.has(ev.type)) continue;
      if (daysBetween(now, parseDate(ev.occurred_at)) <= 7) repliesThisWeek++;
    }

    if (TERMINAL_STATUSES.has(app.status)) continue;
    live++;

    // --- Upcoming interviews -----------------------------------------------------------
    const booked = appEvents.filter(
      (e) => e.scheduled_at && new Date(e.scheduled_at).getTime() >= now.getTime()
    );
    for (const ev of booked) {
      upcoming.push({
        application: app,
        event: ev,
        daysOut: calendarDaysUntil(new Date(ev.scheduled_at as string), now),
      });
    }

    // --- Thank-you due ------------------------------------------------------------------
    // Only events that have actually happened can be thanked for, and only the newest one:
    // a thank-you sent after it clears every earlier round too.
    const lastThankable = appEvents
      .filter((e) => THANK_YOU_EVENT_TYPES.has(e.type) && hasOccurred(e, now))
      .sort((a, b) => occurredInstant(b).getTime() - occurredInstant(a).getTime())[0];

    if (lastThankable) {
      const thankYouSent = appEvents.some(
        (e) => e.type === 'thank_you' && occurredInstant(e) > occurredInstant(lastThankable)
      );
      if (!thankYouSent) {
        const happenedAt = occurredInstant(lastThankable);
        const hoursSince = hoursBetween(now, happenedAt);
        const item: QueueItem = {
          kind: 'thank_you',
          application: app,
          headline: `Thank-you due — ${app.company}`,
          detail: `${app.title ?? 'Role'} · ${lastThankable.type} ${Math.floor(hoursSince)}h ago`,
        };
        if (hoursSince >= timing.thankyou_hours) {
          dueToday.push(item);
          continue;
        }
        // Not due yet — flag it if it comes due tomorrow so nothing lands as a surprise.
        const dueAt = new Date(happenedAt.getTime() + timing.thankyou_hours * 60 * 60 * 1000);
        if (calendarDaysUntil(dueAt, now) === 1) {
          dueTomorrow.push({ ...item, detail: `${app.title ?? 'Role'} · after ${lastThankable.type}` });
          continue;
        }
      }
    }

    // --- Ghost candidate — long silence, handed to the caller to sweep ------------------
    // A booked future interview means they are not silent, whatever the clock says.
    const hasFutureInterview = booked.length > 0;
    const daysSinceContact = daysBetween(now, lastContactDate(app, appEvents[0]));
    if (
      !hasFutureInterview &&
      ACTIVE_INTERVIEW_STATUSES.has(app.status) &&
      daysSinceContact >= timing.ghost_days
    ) {
      ghostCandidates.push(app);
      continue;
    }

    // --- Stale to_apply — sourced but never sent -----------------------------------------
    if (app.status === 'to_apply') {
      const daysSinceCreated = daysBetween(now, parseDate(app.created_at));
      if (daysSinceCreated >= timing.nudge_days_max) {
        dueToday.push({
          kind: 'stale_to_apply',
          application: app,
          headline: `Still sitting in To Apply — ${app.company}`,
          detail: `${app.title ?? 'Role'} · queued ${Math.floor(daysSinceCreated)} days ago`,
        });
        continue;
      }
    }

    // --- Nudge — the stored next_action_due has arrived (or arrives tomorrow) ------------
    if (app.next_action_due) {
      const due = parseDate(app.next_action_due);
      const daysUntilDue = calendarDaysUntil(due, now);
      const item: QueueItem = {
        kind: 'nudge',
        application: app,
        headline: `Nudge due — ${app.company}`,
        detail: app.next_action ?? `${app.title ?? 'Role'} · follow up`,
      };
      if (daysUntilDue <= 0) dueToday.push(item);
      else if (daysUntilDue === 1) dueTomorrow.push(item);
    }
  }

  upcoming.sort(
    (a, b) =>
      new Date(a.event.scheduled_at as string).getTime() -
      new Date(b.event.scheduled_at as string).getTime()
  );

  return {
    appliedToday,
    dueToday,
    dueTomorrow,
    upcoming,
    ghostCandidates,
    momentum: { appliedToday: appliedToday.length, appliedThisWeek, live, repliesThisWeek },
  };
}
