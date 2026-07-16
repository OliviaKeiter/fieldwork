import { supabase } from './supabase';
import { STATUS_LABEL } from './pipeline';
import { formatDate } from './dateUtils';
import type { FwApplication, FwContact, FwEvent, FwJd, FwLesson, FwStatus } from './types';

export interface ExportBundle {
  applications: FwApplication[];
  jds: FwJd[];
  contacts: FwContact[];
  events: FwEvent[];
  lessons: FwLesson[];
}

/** Pulls everything the export needs in one shot. Spec principle (§7): "the user's data
 * walks out the door freely" — this is every table that has a row tied to an application,
 * not just the applications table itself. */
export async function loadExportBundle(): Promise<ExportBundle> {
  const [appsRes, jdsRes, contactsRes, eventsRes, lessonsRes] = await Promise.all([
    supabase.from('fw_applications').select('*').order('company', { ascending: true }),
    supabase.from('fw_jds').select('*'),
    supabase.from('fw_contacts').select('*'),
    supabase.from('fw_events').select('*').order('occurred_at', { ascending: true }),
    supabase.from('fw_lessons').select('*').order('date', { ascending: true }),
  ]);
  if (appsRes.error) throw appsRes.error;
  if (jdsRes.error) throw jdsRes.error;
  if (contactsRes.error) throw contactsRes.error;
  if (eventsRes.error) throw eventsRes.error;
  if (lessonsRes.error) throw lessonsRes.error;
  return {
    applications: (appsRes.data ?? []) as FwApplication[],
    jds: (jdsRes.data ?? []) as FwJd[],
    contacts: (contactsRes.data ?? []) as FwContact[],
    events: (eventsRes.data ?? []) as FwEvent[],
    lessons: (lessonsRes.data ?? []) as FwLesson[],
  };
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = Array.isArray(value) ? value.join('; ') : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRow(values: unknown[]): string {
  return values.map(csvEscape).join(',');
}

/** One row per application, with joined JD/contact/lesson/event summaries flattened in —
 * a genuinely complete export, not a token gesture. Opens cleanly in Excel/Sheets. */
export function buildApplicationsCsv(bundle: ExportBundle): string {
  const jdsByApp = new Map<string, FwJd[]>();
  for (const jd of bundle.jds) {
    if (!jd.application_id) continue;
    const list = jdsByApp.get(jd.application_id) ?? [];
    list.push(jd);
    jdsByApp.set(jd.application_id, list);
  }
  const contactsByApp = new Map<string, FwContact[]>();
  for (const c of bundle.contacts) {
    if (!c.application_id) continue;
    const list = contactsByApp.get(c.application_id) ?? [];
    list.push(c);
    contactsByApp.set(c.application_id, list);
  }
  const eventsByApp = new Map<string, FwEvent[]>();
  for (const e of bundle.events) {
    const list = eventsByApp.get(e.application_id) ?? [];
    list.push(e);
    eventsByApp.set(e.application_id, list);
  }
  const lessonsByApp = new Map<string, FwLesson[]>();
  for (const l of bundle.lessons) {
    if (!l.application_id) continue;
    const list = lessonsByApp.get(l.application_id) ?? [];
    list.push(l);
    lessonsByApp.set(l.application_id, list);
  }

  const header = [
    'company',
    'title',
    'status',
    'date_applied',
    'grade',
    'comp_posted',
    'comp_min',
    'comp_max',
    'remote_type',
    'source',
    'next_action',
    'next_action_due',
    'resume_filename',
    'cover_letter',
    'notes',
    'jd_urls',
    'jd_pain_lines',
    'contacts',
    'event_count',
    'last_event_at',
    'last_event_type',
    'lesson_stated_reasons',
    'created_at',
    'updated_at',
  ];

  const rows = bundle.applications.map((app) => {
    const jds = jdsByApp.get(app.id) ?? [];
    const contacts = contactsByApp.get(app.id) ?? [];
    const events = (eventsByApp.get(app.id) ?? []).slice().sort(
      (a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime()
    );
    const lastEvent = events[events.length - 1];
    const lessons = lessonsByApp.get(app.id) ?? [];

    return csvRow([
      app.company,
      app.title,
      STATUS_LABEL[app.status as FwStatus] ?? app.status,
      app.date_applied,
      app.grade,
      app.comp_posted,
      app.comp_min,
      app.comp_max,
      app.remote_type,
      app.source,
      app.next_action,
      app.next_action_due,
      app.resume_filename,
      app.cover_letter ? 'yes' : 'no',
      app.notes,
      jds.map((j) => j.url).filter(Boolean),
      jds.map((j) => j.pain_line).filter(Boolean),
      contacts.map((c) => `${c.name}${c.role_title ? ` (${c.role_title})` : ''}`),
      events.length,
      lastEvent?.occurred_at ?? '',
      lastEvent?.type ?? '',
      lessons.map((l) => l.stated_reason).filter(Boolean),
      app.created_at,
      app.updated_at,
    ]);
  });

  return [csvRow(header), ...rows].join('\n');
}

/** A readable markdown summary: pipeline grouped by status, then the lessons log. Meant to
 * be genuinely readable, not just a data dump — the spec explicitly wants a "markdown
 * summary" alongside the CSV, not a duplicate of it. */
export function buildApplicationsMarkdown(bundle: ExportBundle): string {
  const lines: string[] = [];
  lines.push(`# Fieldwork export — ${formatDate(new Date().toISOString())}`);
  lines.push('');
  lines.push(`${bundle.applications.length} applications, ${bundle.contacts.length} contacts, ${bundle.events.length} events, ${bundle.lessons.length} lessons logged.`);
  lines.push('');

  const byStatus = new Map<string, FwApplication[]>();
  for (const app of bundle.applications) {
    const list = byStatus.get(app.status) ?? [];
    list.push(app);
    byStatus.set(app.status, list);
  }

  const jdsByApp = new Map<string, FwJd[]>();
  for (const jd of bundle.jds) {
    if (!jd.application_id) continue;
    const list = jdsByApp.get(jd.application_id) ?? [];
    list.push(jd);
    jdsByApp.set(jd.application_id, list);
  }
  const contactsByApp = new Map<string, FwContact[]>();
  for (const c of bundle.contacts) {
    if (!c.application_id) continue;
    const list = contactsByApp.get(c.application_id) ?? [];
    list.push(c);
    contactsByApp.set(c.application_id, list);
  }

  for (const [status, apps] of byStatus) {
    lines.push(`## ${STATUS_LABEL[status as FwStatus] ?? status} (${apps.length})`);
    lines.push('');
    for (const app of apps) {
      lines.push(`### ${app.company} — ${app.title ?? 'Untitled role'}`);
      const meta: string[] = [];
      if (app.date_applied) meta.push(`Applied ${formatDate(app.date_applied)}`);
      if (app.grade) meta.push(`Grade: ${app.grade}`);
      if (app.comp_posted) meta.push(`Comp: ${app.comp_posted}`);
      if (app.remote_type) meta.push(`Remote: ${app.remote_type}`);
      if (app.source) meta.push(`Source: ${app.source}`);
      if (meta.length) lines.push(meta.join(' · '));
      const jds = jdsByApp.get(app.id) ?? [];
      for (const jd of jds) {
        if (jd.pain_line) lines.push(`- Pain line: ${jd.pain_line}`);
        if (jd.url) lines.push(`- JD: ${jd.url}`);
      }
      const contacts = contactsByApp.get(app.id) ?? [];
      if (contacts.length) {
        lines.push(`- Contacts: ${contacts.map((c) => c.name).join(', ')}`);
      }
      if (app.notes) lines.push(`- Notes: ${app.notes}`);
      lines.push('');
    }
  }

  lines.push('## Lessons log');
  lines.push('');
  if (bundle.lessons.length === 0) {
    lines.push('Nothing logged yet.');
  } else {
    for (const lesson of bundle.lessons) {
      lines.push(
        `- **${lesson.company ?? 'Unknown'} — ${lesson.role ?? 'Untitled role'}** (${formatDate(lesson.date)}, reached ${lesson.stage_reached ?? '—'}): ${lesson.stated_reason ?? 'no reason given'}`
      );
    }
  }
  lines.push('');

  return lines.join('\n');
}

export function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
