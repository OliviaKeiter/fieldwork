export function daysBetween(a: Date, b: Date): number {
  const ms = a.getTime() - b.getTime();
  return ms / (1000 * 60 * 60 * 24);
}

export function hoursBetween(a: Date, b: Date): number {
  const ms = a.getTime() - b.getTime();
  return ms / (1000 * 60 * 60);
}

export function addDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + days);
  return next;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Parses a stored date string. Bare YYYY-MM-DD values (fw_lessons.date, contacts
 * last_touch, next_action_due, date pickers) are LOCAL calendar dates — `new Date("Y-M-D")`
 * would read them as UTC midnight, which is the previous evening in US timezones and made
 * dates render one day early. Full ISO timestamps parse normally. */
export function parseDate(iso: string): Date {
  if (DATE_ONLY.test(iso)) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(iso);
}

/** Local-calendar YYYY-MM-DD for the given date (default: now). Use this instead of
 * `toISOString().slice(0, 10)`, which yields the UTC date — tomorrow's date during a US
 * evening. */
export function localDateString(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Converts a date-picker value (YYYY-MM-DD) to a Date for timestamp columns: today picks
 * up the current local time; past/future days anchor at noon LOCAL time so the stored UTC
 * instant stays on the picked calendar day in every nearby timezone. */
export function dateInputToDate(value: string): Date {
  if (value === localDateString()) return new Date();
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

/** Midnight local on the given date. */
export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Whole local calendar days from `from` to `to`: 0 = same day, 1 = tomorrow, -1 = yesterday.
 * Compares dates, not instants, so "tomorrow" means the next calendar day rather than 24
 * hours out — an interview at 9am tomorrow is 1, not 0. */
export function calendarDaysUntil(to: Date, from: Date = new Date()): number {
  return Math.round(
    (startOfDay(to).getTime() - startOfDay(from).getTime()) / (1000 * 60 * 60 * 24)
  );
}

/** "2:30 PM" — the time half of a scheduled interview. */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = parseDate(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "12 days" / "1 day" / "today" — used for aging badges throughout the app. */
export function agingLabel(iso: string | null | undefined): string {
  if (!iso) return 'no date on file';
  const d = parseDate(iso);
  if (Number.isNaN(d.getTime())) return 'no date on file';
  const days = Math.floor(daysBetween(new Date(), d));
  if (days <= 0) return 'today';
  if (days === 1) return '1 day';
  return `${days} days`;
}
