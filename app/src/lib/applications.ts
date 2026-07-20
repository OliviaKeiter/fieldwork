import { supabase } from './supabase';
import type { FwApplication, FwEventType, FwStatus } from './types';
import { addDays, localDateString } from './dateUtils';

export async function listApplications(): Promise<FwApplication[]> {
  const { data, error } = await supabase
    .from('fw_applications')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/** Corrects the company/title on a row — the intake extraction gets these wrong sometimes
 * (or the user filed with blanks), and every dedupe and draft downstream keys off them, so
 * they need to be fixable in place. */
export async function updateApplicationDetails(
  id: string,
  fields: { company: string; title: string | null }
): Promise<void> {
  const { error } = await supabase
    .from('fw_applications')
    .update(fields as never)
    .eq('id', id);
  if (error) throw error;
}

export async function getApplication(id: string): Promise<FwApplication | null> {
  const { data, error } = await supabase
    .from('fw_applications')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function insertEvent(
  applicationId: string,
  type: FwEventType,
  body: string | null,
  occurredAt: Date = new Date(),
  scheduledAt: Date | null = null
): Promise<void> {
  const { error } = await supabase.from('fw_events').insert({
    application_id: applicationId,
    type,
    body,
    // occurred_at is a `date` column: localDateString, not toISOString, which yields the UTC
    // date and logs a US-evening event on tomorrow's timeline. scheduled_at IS a timestamptz,
    // so the full instant is correct there.
    occurred_at: localDateString(occurredAt),
    scheduled_at: scheduledAt ? scheduledAt.toISOString() : null,
  } as never);
  if (error) throw error;
}

/** Updates status and logs a status_change event in one call — every status transition in
 * the app (Pipeline drag, Today actions) should go through this so the timeline stays true. */
export async function setStatus(
  applicationId: string,
  newStatus: FwStatus,
  previousStatus: FwStatus,
  note?: string
): Promise<void> {
  const { error } = await supabase
    .from('fw_applications')
    .update({ status: newStatus } as never)
    .eq('id', applicationId);
  if (error) throw error;

  await insertEvent(
    applicationId,
    'status_change',
    note ?? `${previousStatus} → ${newStatus}`
  );
}

/** Passing on a role you never applied to. The row stays in fw_applications on purpose:
 * daily_loop dedupes sourced candidates against every row regardless of status, so a passed
 * role is what keeps the same posting from being re-recommended tomorrow. Deleting the row
 * would hand it straight back to the next sourcing run. */
export async function passApplication(app: FwApplication, reason?: string): Promise<void> {
  await setStatus(app.id, 'passed', app.status, reason ?? 'Passed — not pursuing.');
}

/** Sweeps applications past the silence threshold to 'ghosted', logging a status_change on
 * each so the timeline shows what happened and when. Called by Today with the candidates
 * buildTodayView identified; returns the applications actually swept so the UI can report
 * the sweep rather than doing it behind the user's back.
 *
 * Ghosting is a status change, not a delete: the row stays, Insights still counts it, and
 * it can be dragged back on the Pipeline if they do resurface. */
export async function autoGhost(apps: FwApplication[]): Promise<FwApplication[]> {
  const swept: FwApplication[] = [];
  for (const app of apps) {
    await setStatus(app.id, 'ghosted', app.status, 'Auto-ghosted — past the silence threshold. Energy banked.');
    swept.push(app);
  }
  return swept;
}

/** Books a screen/round/debrief on the calendar. The event is logged today (occurred_at)
 * but carries the future instant in scheduled_at, which is what marks it as upcoming rather
 * than already-happened — see fw_events.scheduled_at in schema.sql. */
export async function scheduleInterview(
  app: FwApplication,
  type: Extract<FwEventType, 'screen' | 'round' | 'debrief'>,
  at: Date,
  note?: string
): Promise<void> {
  await insertEvent(app.id, type, note ?? null, new Date(), at);
}

/** Bumps next_action_due forward by the given number of days (from the greater of "now" or
 * the existing due date, so repeated snoozes don't stack against the past). */
export async function snoozeNextAction(app: FwApplication, days: number): Promise<void> {
  const base = app.next_action_due && new Date(app.next_action_due) > new Date()
    ? new Date(app.next_action_due)
    : new Date();
  const nextDue = addDays(base, days);
  const { error } = await supabase
    .from('fw_applications')
    .update({ next_action_due: localDateString(nextDue) } as never)
    .eq('id', app.id);
  if (error) throw error;
}

export async function recordRejection(
  app: FwApplication,
  statedReason: string
): Promise<void> {
  await setStatus(app.id, 'rejected', app.status, 'Logged.');

  const { error } = await supabase.from('fw_lessons').insert({
    application_id: app.id,
    company: app.company,
    role: app.title,
    date: localDateString(),
    stage_reached: app.status,
    stated_reason: statedReason,
  } as never);
  if (error) throw error;
}
