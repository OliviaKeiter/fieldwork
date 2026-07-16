import { supabase } from './supabase';
import { invokeFn } from './functions';
import type { FwApplication } from './types';

export interface ResumeContact {
  name: string | null;
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  location: string | null;
  other: string | null;
}

export interface ResumeExperienceEntry {
  title: string;
  company: string;
  dates: string;
  location: string | null;
  bullets: string[];
}

export interface ResumeEducationEntry {
  credential: string;
  institution: string | null;
  dates: string | null;
}

export interface ResumeCertificationEntry {
  /** The credential itself, e.g. "AI-900" or "TS/SCI". */
  name: string;
  /** What it is / who issued it, e.g. "Microsoft Azure AI Fundamentals" or "DoD CAF". */
  issuer: string | null;
  date: string | null;
}

export interface ResumeHighlightItem {
  title: string;
  body: string;
}

/** Tailored highlight section — heading is chosen per-job by the edge function (e.g.
 * "Selected Impact" or "Flagship Products"). Optional: older builds and some model
 * responses omit it, and every renderer must tolerate its absence. */
export interface ResumeHighlightSection {
  heading: string;
  items: ResumeHighlightItem[];
}

export interface ResumeContent {
  contact: ResumeContact;
  summary: string;
  experience: ResumeExperienceEntry[];
  highlight?: ResumeHighlightSection | null;
  skills: string[];
  education: ResumeEducationEntry[];
  /** Certifications and clearance (e.g. TS/SCI, AI-900). Optional so resumes saved before
   * this field existed still parse — every renderer tolerates its absence. */
  certifications?: ResumeCertificationEntry[];
}

export interface ResumeContentResponse {
  content: ResumeContent;
  ats_keywords: string[];
}

export async function buildResumeContent(applicationId: string): Promise<ResumeContentResponse> {
  return invokeFn<ResumeContentResponse>('resume_content', { application_id: applicationId });
}

/** Client-side fallback contact extraction from the fw_profile career record text — the
 * same "extract from the record if present, otherwise null, never fabricate" contract the
 * resume_content edge function follows. Used when an application has no saved
 * resume_content contact block (e.g. drafting a cover letter before building a resume). */
export function contactFromCareerRecord(record: string | null | undefined): ResumeContact {
  const contact: ResumeContact = {
    name: null,
    email: null,
    phone: null,
    linkedin: null,
    location: null,
    other: null,
  };
  if (!record) return contact;

  const email = record.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  if (email) contact.email = email[0];

  const phone = record.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/);
  if (phone) contact.phone = phone[0].trim();

  const linkedin = record.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9_-]+/i);
  if (linkedin) contact.linkedin = linkedin[0];

  // Name: the first non-empty line, if it reads like a plain "First Last" style name
  // (2-5 capitalized words, no digits/@) rather than a section header or sentence.
  const firstLine = record
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find(Boolean);
  if (
    firstLine &&
    /^[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,4}$/.test(firstLine) &&
    !/[@\d]/.test(firstLine)
  ) {
    contact.name = firstLine;
  }

  // Location: an explicit "Location: ..." line if the record has one — never guessed.
  const location = record.match(/^\s*Location:\s*(.+)$/im);
  if (location) contact.location = location[1].trim();

  return contact;
}

/** Applies `fw_profile.file_name_pattern` (e.g. "Jane_Doe_{company}_{title}") to a
 * built resume, falling back to a sane default if no pattern is set. Never hardcodes a name
 * — everything comes from the pattern string + the application row. */
export function resolveFileName(
  pattern: string | null | undefined,
  app: Pick<FwApplication, 'company' | 'title'>,
  candidateName: string | null
): string {
  const company = (app.company || 'Company').replace(/[^a-zA-Z0-9]+/g, '');
  const title = (app.title || 'Role').replace(/[^a-zA-Z0-9]+/g, '');
  const name = (candidateName || 'Resume').replace(/[^a-zA-Z0-9]+/g, '_');

  const nameParts = (candidateName || '').trim().split(/\s+/).filter(Boolean);
  const firstName = (nameParts[0] || 'First').replace(/[^a-zA-Z0-9]+/g, '');
  const lastName = (nameParts.slice(1).join(' ') || 'Last').replace(/[^a-zA-Z0-9]+/g, '');

  const base = pattern && pattern.trim()
    ? pattern
        .replace(/\{company\}/gi, company)
        .replace(/\{title\}|\{jobtitle\}/gi, title)
        .replace(/\{firstname\}/gi, firstName)
        .replace(/\{lastname\}/gi, lastName)
        .replace(/\{name\}/gi, name)
    : `${name}_${company}_${title}`;

  return base.endsWith('.docx') ? base : `${base}.docx`;
}

/** Persists the current (post-edit) resume JSON to fw_applications.resume_content so the
 * build survives the session — the Resume tab and History tab both read it back. */
export async function saveResumeContent(
  applicationId: string,
  content: ResumeContent
): Promise<void> {
  const { error } = await supabase
    .from('fw_applications')
    .update({ resume_content: content } as never)
    .eq('id', applicationId);
  if (error) throw error;
}

/** Prefix that marks a `note` event as a resume-export snapshot. The event body is
 * `${RESUME_EVENT_PREFIX}${filename}\n\n${plain-text resume}` — the timeline shows only the
 * first line, while History expands the full snapshot below it. */
export const RESUME_EVENT_PREFIX = 'Resume built: ';

/** Flattens a resume into readable plain text — the snapshot we keep in the timeline so every
 * exported version stays viewable later, without storing the .docx/.pdf itself. */
export function renderResumePlainText(content: ResumeContent): string {
  const lines: string[] = [];
  const c = content.contact;
  if (c.name) lines.push(c.name);
  const contactBits = [c.email, c.phone, c.linkedin, c.location, c.other].filter(Boolean);
  if (contactBits.length) lines.push(contactBits.join(' · '));

  if (content.summary?.trim()) {
    lines.push('', 'SUMMARY', content.summary.trim());
  }

  if (content.experience.length) {
    lines.push('', 'EXPERIENCE');
    for (const job of content.experience) {
      const head = [job.title, job.company].filter(Boolean).join(' — ');
      const meta = [job.dates, job.location].filter(Boolean).join(' · ');
      const heading = [head, meta].filter(Boolean).join('  |  ');
      if (heading) lines.push('', heading);
      for (const bullet of job.bullets) {
        if (bullet.trim()) lines.push(`• ${bullet.trim()}`);
      }
    }
  }

  if (content.highlight?.items?.length) {
    lines.push('', (content.highlight.heading || 'Highlights').toUpperCase());
    for (const item of content.highlight.items) {
      if (item.title?.trim()) lines.push('', item.title.trim());
      if (item.body?.trim()) lines.push(item.body.trim());
    }
  }

  if (content.skills.length) {
    lines.push('', 'SKILLS', content.skills.join(', '));
  }

  if (content.certifications?.length) {
    lines.push('', 'CERTIFICATIONS & CLEARANCE');
    for (const cert of content.certifications) {
      const line = [cert.name, cert.issuer, cert.date].filter(Boolean).join(' · ');
      if (line) lines.push(line);
    }
  }

  if (content.education.length) {
    lines.push('', 'EDUCATION');
    for (const ed of content.education) {
      const line = [ed.credential, ed.institution, ed.dates].filter(Boolean).join(' · ');
      if (line) lines.push(line);
    }
  }

  return lines.join('\n').trim();
}

/** Splits a resume-export event body back into its filename and the full snapshot text.
 * Returns null for any event that isn't a resume-export note. */
export function parseResumeEventBody(
  body: string | null | undefined
): { filename: string; snapshot: string } | null {
  if (!body || !body.startsWith(RESUME_EVENT_PREFIX)) return null;
  const newline = body.indexOf('\n');
  const firstLine = newline === -1 ? body : body.slice(0, newline);
  const filename = firstLine.slice(RESUME_EVENT_PREFIX.length).trim();
  const snapshot = newline === -1 ? '' : body.slice(newline + 1).replace(/^\n+/, '');
  return { filename, snapshot };
}

/** Records that a resume was built for this application: sets resume_filename, persists the
 * final resume JSON, and logs a timeline event carrying the full readable resume text as a
 * snapshot. `fw_event_type` has no dedicated "resume built" value, so this uses the closest
 * existing one ('note'); RESUME_EVENT_PREFIX lets the timeline and History treat it
 * specially. We store the text, never the generated document. */
export async function recordResumeBuilt(
  applicationId: string,
  filename: string,
  content?: ResumeContent
): Promise<void> {
  const update: Record<string, unknown> = { resume_filename: filename };
  if (content) update.resume_content = content;
  const { error: updateError } = await supabase
    .from('fw_applications')
    .update(update as never)
    .eq('id', applicationId);
  if (updateError) throw updateError;

  const body = content
    ? `${RESUME_EVENT_PREFIX}${filename}\n\n${renderResumePlainText(content)}`
    : `${RESUME_EVENT_PREFIX}${filename}`;
  const { error: eventError } = await supabase.from('fw_events').insert({
    application_id: applicationId,
    type: 'note',
    body,
    occurred_at: new Date().toISOString(),
  } as never);
  if (eventError) throw eventError;
}
