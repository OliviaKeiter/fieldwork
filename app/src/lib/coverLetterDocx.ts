import { Document, Packer, Paragraph, TextRun } from 'docx';
import {
  contactLine,
  escapeHtml,
  getTemplateSpec,
  headerParagraphs,
  twipsToIn,
  DEFAULT_RESUME_STYLE,
  type ResumeStyle,
  type TemplateSpec,
} from './resumeDocx';
import type { ResumeContact } from './resume';

// Cover letter renderers that share the resume layouts' design language. Everything
// visual (accent hexes, fonts, name-header treatment, page margins) comes from the same
// TemplateSpec objects resumeDocx.ts builds for a layout+color pair — imported, not
// duplicated — so a letter and a resume exported with the same style pair as a set.
//
// A letter has no sidebar: the two-column layout renders the LETTER single-column
// but keeps its rule-under-contact header treatment (headerParagraphs handles that
// per layout).

export interface CoverLetterInput {
  contact: ResumeContact;
  /** Letter body text — split into paragraphs on blank lines. Any trailing sign-off in it
   * is stripped before rendering (see stripSignOff); the rendered sign-off always comes
   * from the two fields below. */
  body: string;
  /** Closing line, e.g. "Best wishes,". Falls back to the default. */
  signOff?: string;
  /** Signature name under the closing line. Falls back to the contact's name. */
  signatureName?: string;
  /** Letter date; defaults to today (local). */
  date?: Date;
}

function letterDate(input: CoverLetterInput): string {
  return (input.date ?? new Date()).toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Splits the draft text into paragraphs on blank lines (any run of 2+ newlines). */
function bodyParagraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
}

const DEFAULT_GREETING = 'Dear Hiring Team,';
export const DEFAULT_SIGNOFF = 'Best wishes,';

const CLOSER_RE =
  /^(best(\s+wishes|\s+regards)?|sincerely(\s+yours)?|warm\s+regards|warmly|kind\s+regards|regards|respectfully(\s+yours)?|thanks|thank\s+you|cheers|all\s+the\s+best|with\s+(gratitude|appreciation|thanks|enthusiasm))\s*,?$/i;

/** Removes a trailing sign-off ("Best wishes,\nJane Doe", or either half alone) from the
 * body text. The rendered letter ALWAYS gets its sign-off from CoverLetterInput's own
 * fields, so one left in the text would print twice — the old name-matching heuristic
 * doubled exactly when the contact name failed to parse. This is its stricter inverse:
 * strip from the body, render from the fields, no detection needed at render time.
 *
 * Deliberately conservative: a bare short line is only treated as a signature when a
 * closer line precedes it or it equals the known name, so real closing sentences
 * ("Thank you for your consideration.") survive untouched. */
export function stripSignOff(body: string, name?: string | null): string {
  const lines = body.trimEnd().split('\n');
  const isBlank = (s: string) => !s.trim();
  const nameNorm = name?.trim().toLowerCase() || null;

  let end = lines.length;
  while (end > 0 && isBlank(lines[end - 1])) end--;

  // Tentative signature line: short, capitalized, no sentence punctuation.
  let sigEnd = end;
  if (end > 0) {
    const t = lines[end - 1].trim();
    const looksLikeName =
      !/[.!?:]$/.test(t) &&
      t.split(/\s+/).length <= 4 &&
      (nameNorm ? t.toLowerCase() === nameNorm : /^[A-Z][\w.'-]*(\s+[A-Z][\w.'-]*){0,3}$/.test(t));
    if (looksLikeName) sigEnd = end - 1;
  }

  let closerEnd = sigEnd;
  while (closerEnd > 0 && isBlank(lines[closerEnd - 1])) closerEnd--;
  const hasCloser = closerEnd > 0 && CLOSER_RE.test(lines[closerEnd - 1].trim());

  if (hasCloser) {
    end = closerEnd - 1;
  } else if (sigEnd < end && nameNorm && lines[end - 1].trim().toLowerCase() === nameNorm) {
    end = sigEnd;
  }
  while (end > 0 && isBlank(lines[end - 1])) end--;
  return lines.slice(0, end).join('\n');
}

/** True when the first body paragraph is already a salutation (the user typed their own
 * "Dear Jane," at the top, or the model opened with one) — so we don't stack two. */
function hasGreeting(paragraphs: string[]): boolean {
  const first = (paragraphs[0] ?? '').trim().toLowerCase();
  return /^(dear |hello|hi[ ,]|greetings|to whom|to the )/.test(first);
}

export async function buildCoverLetterDocx(
  input: CoverLetterInput,
  style: ResumeStyle = DEFAULT_RESUME_STYLE
): Promise<Blob> {
  const spec = getTemplateSpec(style);
  const name = input.contact.name;
  const paragraphs = bodyParagraphs(stripSignOff(input.body, input.signatureName ?? name));
  const signOffText = input.signOff?.trim() || DEFAULT_SIGNOFF;
  const signatureName = input.signatureName?.trim() || name || '';

  const children: Paragraph[] = [
    // Identical name/contact header to the resume for this layout+color.
    ...headerParagraphs({ contact: input.contact }, spec),
    new Paragraph({
      spacing: { before: 120, after: 240 },
      children: [new TextRun({ text: letterDate(input), size: 20, color: spec.dim })],
    }),
  ];

  // Salutation — skipped only if the body already opens with its own.
  if (!hasGreeting(paragraphs)) {
    children.push(
      new Paragraph({
        spacing: { after: 160 },
        children: [new TextRun({ text: DEFAULT_GREETING, size: 20, color: spec.body })],
      })
    );
  }

  children.push(
    ...paragraphs.map(
      (p) =>
        new Paragraph({
          spacing: { after: 160, line: 276 },
          children: [new TextRun({ text: p, size: 20, color: spec.body })],
        })
    )
  );

  // The sign-off block always renders from the input fields — never from the body.
  children.push(
    new Paragraph({
      spacing: { before: 160, after: 40 },
      children: [new TextRun({ text: signOffText, size: 20, color: spec.body })],
    }),
    new Paragraph({
      children: [new TextRun({ text: signatureName, bold: true, size: 20, color: spec.accent })],
    })
  );

  const doc = new Document({
    sections: [{ properties: { page: { margin: spec.margins } }, children }],
    styles: { default: { document: { run: { font: spec.font } } } },
  });

  return Packer.toBlob(doc);
}

// ---------------------------------------------------------------------------
// Print / "Save as PDF" path — mirrors resumeDocx's approach (print HTML with a
// per-layout @page margin rule derived from the same twip margins as the .docx).
// The letter prints from a hidden same-origin iframe with fully inlined styles, so it
// never collides with ResumeStudio's #resume-print-root visibility trick.
// ---------------------------------------------------------------------------

/** Per-layout header CSS mirroring the two treatments in global.css / headerParagraphs,
 * but built from the shared spec so the colors can never drift from the .docx output. */
function headerCss(spec: TemplateSpec): string {
  const accent = `#${spec.accent}`;
  const fill = `#${spec.sidebarFill}`;
  if (spec.layout === 'two-column') {
    // Rule-under-contact treatment.
    return `
        h1 { font-size: 26pt; color: ${accent}; font-weight: bold; }
        .letter-contact { border-bottom: 1.5pt solid ${accent}; padding-bottom: 4pt; }`;
  }
  // Name-band treatment.
  return `
        .letter-header { background: ${fill}; padding: 10pt 12pt; margin-bottom: 8pt; }
        h1 { font-size: 30pt; font-weight: normal; color: ${accent}; letter-spacing: 1pt; }`;
}

/** Complete standalone HTML document for the print iframe. */
export function renderCoverLetterPrintHtml(
  input: CoverLetterInput,
  style: ResumeStyle = DEFAULT_RESUME_STYLE
): string {
  const spec = getTemplateSpec(style);
  const m = spec.margins;
  const fontStack =
    spec.font === 'Georgia' ? `Georgia, 'Times New Roman', serif` : `Arial, Helvetica, sans-serif`;
  const contact = contactLine({ contact: input.contact });
  const name = input.contact.name;
  const paragraphs = bodyParagraphs(stripSignOff(input.body, input.signatureName ?? name));
  const signOffText = input.signOff?.trim() || DEFAULT_SIGNOFF;
  const signatureName = input.signatureName?.trim() || name || '';
  const greeting = hasGreeting(paragraphs) ? '' : `<p class="letter-greeting">${DEFAULT_GREETING}</p>`;
  // Always from the input fields, never detected in the body (see stripSignOff).
  const signOff = `<p class="letter-signoff">${escapeHtml(signOffText)}</p><p class="letter-signature">${escapeHtml(signatureName)}</p>`;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Cover letter</title>
<style>
  /* Same per-layout @page margins fix as renderResumePrintHtml — derived from the
     shared spec's twip margins so the PDF page matches the .docx section. */
  @page { margin: ${twipsToIn(m.top)} ${twipsToIn(m.right)} ${twipsToIn(m.bottom)} ${twipsToIn(m.left)}; }
  body {
    margin: 0;
    font-family: ${fontStack};
    color: #${spec.body};
    background: #fff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  h1 { margin: 0 0 2pt; }
  .letter-contact { font-size: 8.5pt; color: #${spec.dim}; margin: 0; }
  .letter-date { font-size: 10pt; color: #${spec.dim}; margin: 14pt 0 16pt; }
  .letter-greeting { font-size: 10.5pt; margin: 0 0 10pt; }
  .letter-body p { font-size: 10.5pt; line-height: 1.45; margin: 0 0 10pt; }
  .letter-signoff { font-size: 10.5pt; margin: 14pt 0 2pt; }
  .letter-signature { font-size: 10.5pt; font-weight: bold; color: #${spec.accent}; margin: 0; }
  ${headerCss(spec)}
</style>
</head>
<body>
  <div class="letter-header">
    <h1>${escapeHtml(name ?? 'Candidate Name')}</h1>
    ${contact ? `<p class="letter-contact">${escapeHtml(contact)}</p>` : ''}
  </div>
  <p class="letter-date">${escapeHtml(letterDate(input))}</p>
  ${greeting}
  <div class="letter-body">
    ${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n    ')}
  </div>
  ${signOff}
</body>
</html>`;
}

/** Opens the browser print dialog for the letter via a hidden same-origin iframe — the
 * same window.print()/@page mechanism ResumeStudio uses, isolated so it can't co-print
 * with a resume print root elsewhere on the page. */
export function printCoverLetter(input: CoverLetterInput, style: ResumeStyle = DEFAULT_RESUME_STYLE): void {
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument;
  if (!doc) {
    iframe.remove();
    return;
  }
  doc.open();
  doc.write(renderCoverLetterPrintHtml(input, style));
  doc.close();

  // Give the iframe a tick to lay out, then print; clean up after the dialog closes
  // (afterprint) with a generous fallback timer for browsers that skip the event.
  const cleanup = () => iframe.remove();
  iframe.contentWindow?.addEventListener('afterprint', cleanup);
  setTimeout(() => {
    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
    setTimeout(cleanup, 60000);
  }, 50);
}
