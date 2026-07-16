import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
  BorderStyle,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ShadingType,
} from 'docx';
import type { ResumeContent } from './resume';

// Two layout renderers ported from a set of four hand-built .docx resume templates,
// now split into LAYOUT x COLOR instead of four fixed combos.
//
// Layout notes:
// - "two-column" uses a docx Table with invisible borders and a shaded sidebar cell — the
//   same technique the original .docx files use. The table holds PAGE 1 ONLY: the sidebar
//   (skills + education) plus as much main content as fits beside it; everything that
//   would spill onto page 2 renders full-width AFTER the table (see splitTwoColumnContent).
//   Header treatment: bold accent name + contact line closed with a heavy accent rule
//   (the Template1 treatment — it reads cleanly in every palette, unlike the solid
//   banner, which fought the darker accents).
// - "editorial" is tables-free (ATS-safest). Header treatment: tinted name band done with
//   paragraph shading (the Template2 treatment — the band shows off each palette's tint
//   and keeps the serif look distinct from the two-column rule header).
// No personal facts live here — everything renders from the ResumeContent passed in.

export type ResumeLayoutId = 'two-column' | 'editorial';
export type ResumeColorId = 'purple' | 'blue' | 'moss' | 'terracotta' | 'slate' | 'burgundy';

export interface ResumeStyle {
  layout: ResumeLayoutId;
  color: ResumeColorId;
}

export interface ResumeLayoutOption {
  id: ResumeLayoutId;
  label: string;
  description: string;
}

export const RESUME_LAYOUTS: ResumeLayoutOption[] = [
  {
    id: 'editorial',
    label: 'Editorial',
    description: 'Georgia serif, single column, tinted name band, thin section rules. ATS-safest.',
  },
  {
    id: 'two-column',
    label: 'Two-column',
    description: 'Arial, main column + tinted sidebar for skills and education on page 1.',
  },
];

/** Accent family for one palette. `accent` carries headings/rules, `accentSoft` sub-labels,
 * `sidebarFill` the sidebar tint / editorial name band. Tints are derived the same way the
 * original purple (#5B2C91/#8B5FBF/#F0E8F7) and blue (#3B7AB0/#6FA0CC/#E8F0F7) families
 * were: soft = accent lightened toward white ~35%, fill = accent at ~92% white. All work
 * on white paper. Hexes have no leading # (docx convention). */
export interface ResumeColorOption {
  id: ResumeColorId;
  label: string;
  accent: string;
  accentSoft: string;
  sidebarFill: string;
}

export const RESUME_COLORS: ResumeColorOption[] = [
  { id: 'purple', label: 'Purple', accent: '5B2C91', accentSoft: '8B5FBF', sidebarFill: 'F0E8F7' },
  { id: 'blue', label: 'Blue', accent: '3B7AB0', accentSoft: '6FA0CC', sidebarFill: 'E8F0F7' },
  { id: 'moss', label: 'Moss', accent: '5F7A53', accentSoft: '8CA382', sidebarFill: 'ECF1E9' },
  { id: 'terracotta', label: 'Terracotta', accent: 'C9702F', accentSoft: 'D99A6B', sidebarFill: 'FAEDE2' },
  { id: 'slate', label: 'Slate', accent: '44546A', accentSoft: '7A8BA3', sidebarFill: 'EAEEF3' },
  { id: 'burgundy', label: 'Burgundy', accent: '7B2D43', accentSoft: 'A65C72', sidebarFill: 'F6E9ED' },
];

/** Matches the old default template ('purple-editorial'). */
export const DEFAULT_RESUME_STYLE: ResumeStyle = { layout: 'editorial', color: 'purple' };

export function isResumeLayoutId(value: unknown): value is ResumeLayoutId {
  return typeof value === 'string' && RESUME_LAYOUTS.some((l) => l.id === value);
}

export function isResumeColorId(value: unknown): value is ResumeColorId {
  return typeof value === 'string' && RESUME_COLORS.some((c) => c.id === value);
}

/** Maps a legacy `resume_template` fw_settings value (the pre-split combined ids) onto the
 * layout+color pair that reproduces the same look, so existing users keep their choice. */
export function migrateLegacyTemplate(value: unknown): ResumeStyle | null {
  switch (value) {
    case 'purple-two-column':
      return { layout: 'two-column', color: 'purple' };
    case 'blue-two-column':
      return { layout: 'two-column', color: 'blue' };
    case 'purple-editorial':
      return { layout: 'editorial', color: 'purple' };
    case 'blue-editorial':
      return { layout: 'editorial', color: 'blue' };
    default:
      return null;
  }
}

/** Resolves raw persisted settings (new keys + legacy fallback) to a valid ResumeStyle.
 * Precedence per field: valid new key > legacy template mapping > default. */
export function resolveResumeStyle(raw: {
  layout: unknown;
  color: unknown;
  legacyTemplate: unknown;
}): ResumeStyle {
  const migrated = migrateLegacyTemplate(raw.legacyTemplate);
  return {
    layout: isResumeLayoutId(raw.layout) ? raw.layout : migrated?.layout ?? DEFAULT_RESUME_STYLE.layout,
    color: isResumeColorId(raw.color) ? raw.color : migrated?.color ?? DEFAULT_RESUME_STYLE.color,
  };
}

/** Design tokens for one layout+color pairing. Sizes are docx half-points, spacing values
 * twentieths of a point — the same units as the source files' w:sz / w:spacing attrs. */
/** Font sizes for one layout, in docx half-points (size 21 = 10.5pt). Kept layout-aware so
 * the editorial (single-column) resume can run at a comfortable ~10.5pt reading size while
 * the denser two-column layout keeps the smaller sizes its page-1 split math is calibrated
 * against (see splitTwoColumnContent). */
export interface TemplateSizes {
  name: number;
  contact: number;
  sectionHeading: number;
  sidebarHeading: number;
  jobTitle: number;
  jobMeta: number;
  body: number; // bullets, summary, highlight bodies
  highlightTitle: number;
  skills: number;
  eduCredential: number;
  eduMeta: number;
}

export interface TemplateSpec {
  layout: ResumeLayoutId;
  font: string;
  accent: string; // primary accent (headings, rules)
  accentSoft: string; // secondary accent (sub-labels)
  body: string; // body text
  dim: string; // secondary text
  sidebarFill: string; // sidebar / name-band tint
  sizes: TemplateSizes;
  margins: { top: number; bottom: number; left: number; right: number };
}

// Editorial runs at a normal resume reading size (10.5pt body). Two-column stays denser —
// its sizes are load-bearing for the page-1 line-budget estimate, so leave them be.
const EDITORIAL_SIZES: TemplateSizes = {
  name: 60,
  contact: 18,
  sectionHeading: 28,
  sidebarHeading: 20,
  jobTitle: 24,
  jobMeta: 20,
  body: 21,
  highlightTitle: 22,
  skills: 20,
  eduCredential: 20,
  eduMeta: 20,
};
const TWO_COLUMN_SIZES: TemplateSizes = {
  name: 52,
  contact: 18,
  sectionHeading: 24,
  sidebarHeading: 20,
  jobTitle: 22,
  jobMeta: 20,
  body: 18,
  highlightTitle: 20,
  skills: 17,
  eduCredential: 18,
  eduMeta: 17,
};

/** Builds the design tokens for a layout+color pair — exported so coverLetterDocx.ts
 * renders letters from the exact same spec objects as the resumes (matched set). */
export function getTemplateSpec(style: ResumeStyle): TemplateSpec {
  const palette = RESUME_COLORS.find((c) => c.id === style.color) ?? RESUME_COLORS[0];
  const twoCol = style.layout === 'two-column';
  return {
    layout: style.layout,
    font: twoCol ? 'Arial' : 'Georgia',
    accent: palette.accent,
    accentSoft: palette.accentSoft,
    body: '1F1F1F',
    dim: '555555',
    sidebarFill: palette.sidebarFill,
    sizes: twoCol ? TWO_COLUMN_SIZES : EDITORIAL_SIZES,
    margins: twoCol
      ? { top: 720, bottom: 720, left: 720, right: 720 }
      : { top: 540, bottom: 540, left: 720, right: 720 },
  };
}

export function contactLine(content: Pick<ResumeContent, 'contact'>): string {
  const parts = [
    content.contact.location,
    content.contact.phone,
    content.contact.email,
    content.contact.linkedin,
    content.contact.other,
  ].filter((p): p is string => Boolean(p && p.trim()));
  return parts.join('   |   ');
}

// ---------------------------------------------------------------------------
// Shared docx fragments
// ---------------------------------------------------------------------------

type Job = ResumeContent['experience'][number];
type HighlightItem = { title: string; body: string };

function jobParagraphs(jobs: Job[], spec: TemplateSpec): Paragraph[] {
  const out: Paragraph[] = [];
  const editorial = spec.layout === 'editorial';

  for (const job of jobs) {
    out.push(
      new Paragraph({
        spacing: { before: 120, after: 20 },
        children: [new TextRun({ text: job.title, bold: true, size: spec.sizes.jobTitle, color: spec.accent })],
      })
    );
    const metaParts = [job.company, job.dates, job.location].filter((p): p is string => Boolean(p && p.trim()));
    if (metaParts.length > 0) {
      // Editorial sets the company line in caps (the Template2 treatment).
      const text = editorial
        ? [metaParts[0].toUpperCase(), ...metaParts.slice(1)].join('   |   ')
        : metaParts.join('  |  ');
      out.push(
        new Paragraph({
          spacing: { after: 60 },
          children: [new TextRun({ text, bold: true, size: spec.sizes.jobMeta, color: spec.body })],
        })
      );
    }
    for (const bullet of job.bullets) {
      if (!bullet.trim()) continue;
      out.push(
        new Paragraph({
          bullet: { level: 0 },
          spacing: { after: 40, line: 250 },
          children: [new TextRun({ text: bullet, size: spec.sizes.body, color: spec.body })],
        })
      );
    }
  }
  return out;
}

/** Non-empty highlight items, or [] when the section is absent/blank. */
function validHighlightItems(content: ResumeContent): HighlightItem[] {
  const hl = content.highlight;
  if (!hl || !hl.heading.trim()) return [];
  return hl.items.filter((it) => it.title.trim() || it.body.trim());
}

/** Tailored highlight items ("Selected Impact" / "Flagship Products" / etc.) — bold accent
 * title line followed by a 1-2 sentence body. Heading is rendered by the caller so the
 * two-column layout can split the section across the page-1 table and the full-width tail. */
function highlightItemParagraphs(items: HighlightItem[], spec: TemplateSpec): Paragraph[] {
  const out: Paragraph[] = [];
  for (const item of items) {
    out.push(
      new Paragraph({
        spacing: { before: 100, after: 20 },
        children: [new TextRun({ text: item.title, bold: true, size: spec.sizes.highlightTitle, color: spec.accent })],
      })
    );
    if (item.body.trim()) {
      out.push(
        new Paragraph({
          spacing: { after: 60, line: 250 },
          children: [new TextRun({ text: item.body, size: spec.sizes.body, color: spec.body })],
        })
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section headings (per-layout treatments, from the source files)
// ---------------------------------------------------------------------------

function sectionHeading(text: string, spec: TemplateSpec): Paragraph {
  if (spec.layout === 'two-column') {
    // Template1 treatment: UPPERCASE, 12pt bold accent, +2pt tracking, accent rule (sz 8).
    return new Paragraph({
      spacing: { before: 160, after: 80 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: spec.accent, space: 4 } },
      children: [
        new TextRun({ text: text.toUpperCase(), bold: true, size: spec.sizes.sectionHeading, color: spec.accent, characterSpacing: 40 }),
      ],
    });
  }
  // Template2 treatment: title case, non-bold serif accent, thin rule (sz 6).
  return new Paragraph({
    spacing: { before: 180, after: 40 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: spec.accent, space: 4 } },
    children: [new TextRun({ text, size: spec.sizes.sectionHeading, color: spec.accent })],
  });
}

function sidebarHeading(text: string, spec: TemplateSpec): Paragraph {
  return new Paragraph({
    spacing: { before: 160, after: 60 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: spec.accent, space: 3 } },
    children: [
      new TextRun({
        text: text.toUpperCase(),
        bold: true,
        size: spec.sizes.sidebarHeading,
        color: spec.accent,
        characterSpacing: 40,
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Header treatments (one per layout)
// ---------------------------------------------------------------------------

/** Name/contact header treatment for a layout. Exported so the cover letter renderer
 * (coverLetterDocx.ts) produces the identical header — resume and letter pair as a set. */
export function headerParagraphs(content: Pick<ResumeContent, 'contact'>, spec: TemplateSpec): Paragraph[] {
  const name = content.contact.name ?? 'Candidate Name';
  const contact = contactLine(content);
  const out: Paragraph[] = [];

  if (spec.layout === 'two-column') {
    // Rule-under-contact treatment: 26pt bold accent name; contact line closed off with
    // a heavy accent rule.
    out.push(
      new Paragraph({
        spacing: { after: 40 },
        children: [new TextRun({ text: name, bold: true, size: spec.sizes.name, color: spec.accent })],
      })
    );
    if (contact) {
      out.push(
        new Paragraph({
          spacing: { after: 200 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: spec.accent, space: 6 } },
          children: [new TextRun({ text: contact, size: spec.sizes.contact, color: spec.dim })],
        })
      );
    }
    return out;
  }

  // Name-band treatment: tinted band (paragraph shading, so the layout stays tables-free)
  // with a 30pt non-bold serif accent name + dim contact.
  out.push(
    new Paragraph({
      shading: { type: ShadingType.CLEAR, fill: spec.sidebarFill },
      spacing: { before: 120, after: 40 },
      indent: { left: 160, right: 160 },
      children: [new TextRun({ text: name, size: spec.sizes.name, color: spec.accent, characterSpacing: 20 })],
    })
  );
  if (contact) {
    out.push(
      new Paragraph({
        shading: { type: ShadingType.CLEAR, fill: spec.sidebarFill },
        spacing: { after: 160 },
        indent: { left: 160, right: 160 },
        children: [new TextRun({ text: contact, size: spec.sizes.contact, color: spec.dim })],
      })
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Two-column page-1 split
// ---------------------------------------------------------------------------

// docx has no layout engine, so the "two-column on page 1 only" rule is enforced with a
// conservative line-budget estimate. All numbers derive from the template geometry:
//
//   Page: US Letter, 15840 twips tall; two-column margins 720 top + 720 bottom
//     -> 14400 twips of writable height.
//   Header (26pt name + contact + rule + spacing) ~= 1160 twips.
//   Fill target: 87% of the remaining height beside the sidebar (slightly under-filling
//     page 1 is fine; the table spilling to page 2 is the bug)
//     -> budget = (14400 - 1160) * 0.87 ~= 11520 twips.
//   Line height: bullets/body use line:250 (12.5pt) + after:40 -> ~265 twips per line
//     -> LINE BUDGET = floor(11520 / 265) = 43 lines.
//
//   Chars per line: main cell is 7200 dxa minus 240 right padding = 6960 twips wide.
//     Body text is 9pt Arial (size 18 half-points); average glyph ~0.55em = 4.95pt =
//     99 twips -> 70 chars/line, 66 for bullets (360-twip bullet indent).
const TWO_COL_LINE_BUDGET = Math.floor(((15840 - 720 - 720 - 1160) * 0.87) / 265); // 43
const TWO_COL_CPL = Math.floor((7200 - 240) / 99); // 70
const TWO_COL_CPL_BULLET = Math.floor((7200 - 240 - 360) / 99); // 66
const HEADING_LINES = 2; // before-spacing + 12-13pt text + rule + after-spacing

function textLines(text: string, cpl: number): number {
  return Math.max(1, Math.ceil(text.trim().length / cpl));
}

function jobLines(job: Job): number {
  const metaParts = [job.company, job.dates, job.location].filter((p) => p && p.trim());
  let lines = 1.5 + (metaParts.length > 0 ? 1.25 : 0); // title (incl before-spacing) + meta
  for (const bullet of job.bullets) {
    if (!bullet.trim()) continue;
    lines += textLines(bullet, TWO_COL_CPL_BULLET);
  }
  return lines;
}

function highlightItemLines(item: HighlightItem): number {
  return 1.5 + (item.body.trim() ? textLines(item.body, TWO_COL_CPL) + 0.5 : 0);
}

/** How much of the main-column content goes INSIDE the page-1 table. Content order is
 * summary -> experience -> highlight; the split is at job / highlight-item granularity.
 * Everything past the split renders full-width after the table. Exported for tests and
 * the print-HTML renderer (both paths must split identically). */
export interface TwoColumnSplit {
  /** Experience entries rendered inside the table (prefix of content.experience). */
  page1JobCount: number;
  /** True when the highlight section heading fits inside the table. */
  page1HighlightHeading: boolean;
  /** Highlight items rendered inside the table (prefix of the non-empty items). */
  page1HighlightCount: number;
}

export function splitTwoColumnContent(content: ResumeContent): TwoColumnSplit {
  let used = 0;
  if (content.summary) {
    used += HEADING_LINES + textLines(content.summary, TWO_COL_CPL) + 0.5;
  }

  let page1JobCount = 0;
  if (content.experience.length > 0) {
    used += HEADING_LINES;
    for (const job of content.experience) {
      const cost = jobLines(job);
      // Always keep at least one job beside the sidebar, even if the estimate says it
      // overflows — an empty main column reads worse than a slightly long page 1.
      if (page1JobCount > 0 && used + cost > TWO_COL_LINE_BUDGET) break;
      used += cost;
      page1JobCount++;
    }
  }

  // Highlight only enters the table when every job fit AND the heading plus at least the
  // first item fit too — a lone heading at the bottom of the table would orphan.
  let page1HighlightHeading = false;
  let page1HighlightCount = 0;
  const items = validHighlightItems(content);
  if (page1JobCount === content.experience.length && items.length > 0) {
    if (used + HEADING_LINES + highlightItemLines(items[0]) <= TWO_COL_LINE_BUDGET) {
      page1HighlightHeading = true;
      used += HEADING_LINES;
      for (const item of items) {
        const cost = highlightItemLines(item);
        if (used + cost > TWO_COL_LINE_BUDGET) break;
        used += cost;
        page1HighlightCount++;
      }
    }
  }

  return { page1JobCount, page1HighlightHeading, page1HighlightCount };
}

// ---------------------------------------------------------------------------
// Layout assembly
// ---------------------------------------------------------------------------

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } as const;
const NO_BORDERS = {
  top: NO_BORDER,
  bottom: NO_BORDER,
  left: NO_BORDER,
  right: NO_BORDER,
  insideHorizontal: NO_BORDER,
  insideVertical: NO_BORDER,
};

function buildEditorialChildren(content: ResumeContent, spec: TemplateSpec): Paragraph[] {
  const children: Paragraph[] = [...headerParagraphs(content, spec)];

  if (content.summary) {
    children.push(sectionHeading('Profile', spec));
    children.push(
      new Paragraph({
        alignment: AlignmentType.JUSTIFIED,
        spacing: { after: 60, line: 270 },
        children: [new TextRun({ text: content.summary, size: spec.sizes.body, color: spec.body })],
      })
    );
  }

  if (content.experience.length > 0) {
    children.push(sectionHeading('Professional Experience', spec));
    children.push(...jobParagraphs(content.experience, spec));
  }

  const highlightItems = validHighlightItems(content);
  if (highlightItems.length > 0 && content.highlight) {
    children.push(sectionHeading(content.highlight.heading, spec));
    children.push(...highlightItemParagraphs(highlightItems, spec));
  }

  if (content.skills.length > 0) {
    children.push(sectionHeading('Skills', spec));
    children.push(
      new Paragraph({
        spacing: { after: 30, line: 250 },
        children: [new TextRun({ text: content.skills.join('  •  '), size: spec.sizes.skills, color: spec.body })],
      })
    );
  }

  if ((content.certifications?.length ?? 0) > 0) {
    children.push(sectionHeading('Certifications & Clearance', spec));
    for (const cert of content.certifications ?? []) {
      const rest = [cert.issuer, cert.date].filter((p): p is string => Boolean(p && p.trim())).join('  |  ');
      children.push(
        new Paragraph({
          spacing: { after: 30, line: 250 },
          children: [
            new TextRun({ text: cert.name, bold: true, size: spec.sizes.eduCredential, color: spec.body }),
            ...(rest ? [new TextRun({ text: `  |  ${rest}`, size: spec.sizes.eduMeta, color: spec.body })] : []),
          ],
        })
      );
    }
  }

  if (content.education.length > 0) {
    children.push(sectionHeading('Education', spec));
    for (const ed of content.education) {
      const rest = [ed.institution, ed.dates].filter((p): p is string => Boolean(p && p.trim())).join(' | ');
      children.push(
        new Paragraph({
          spacing: { after: 30, line: 250 },
          children: [
            new TextRun({ text: ed.credential, bold: true, size: spec.sizes.eduCredential, color: spec.body }),
            ...(rest ? [new TextRun({ text: `  |  ${rest}`, size: spec.sizes.eduMeta, color: spec.body })] : []),
          ],
        })
      );
    }
  }

  return children;
}

function buildTwoColumnChildren(content: ResumeContent, spec: TemplateSpec): (Paragraph | Table)[] {
  const split = splitTwoColumnContent(content);
  const highlightItems = validHighlightItems(content);

  // Main-column content INSIDE the page-1 table: summary + the jobs (and possibly
  // highlight items) that fit the line budget beside the sidebar.
  const main: Paragraph[] = [];
  if (content.summary) {
    main.push(sectionHeading('Summary', spec));
    main.push(
      new Paragraph({
        spacing: { after: 60, line: 250 },
        children: [new TextRun({ text: content.summary, size: spec.sizes.body, color: spec.body })],
      })
    );
  }
  if (content.experience.length > 0) {
    main.push(sectionHeading('Experience', spec));
    main.push(...jobParagraphs(content.experience.slice(0, split.page1JobCount), spec));
  }
  if (split.page1HighlightHeading && content.highlight) {
    main.push(sectionHeading(content.highlight.heading, spec));
    main.push(...highlightItemParagraphs(highlightItems.slice(0, split.page1HighlightCount), spec));
  }

  const side: Paragraph[] = [];
  if (content.skills.length > 0) {
    side.push(sidebarHeading('Skills', spec));
    for (const skill of content.skills) {
      side.push(
        new Paragraph({
          spacing: { after: 20, line: 240 },
          children: [new TextRun({ text: skill, size: spec.sizes.skills, color: spec.body })],
        })
      );
    }
  }
  if ((content.certifications?.length ?? 0) > 0) {
    side.push(sidebarHeading('Certifications & Clearance', spec));
    for (const cert of content.certifications ?? []) {
      side.push(
        new Paragraph({
          spacing: { after: 10 },
          children: [new TextRun({ text: cert.name, bold: true, size: spec.sizes.eduCredential, color: spec.body })],
        })
      );
      const rest = [cert.issuer, cert.date].filter((p): p is string => Boolean(p && p.trim())).join(' | ');
      if (rest) {
        side.push(
          new Paragraph({
            spacing: { after: 60 },
            children: [new TextRun({ text: rest, size: spec.sizes.eduMeta, color: spec.dim })],
          })
        );
      }
    }
  }
  if (content.education.length > 0) {
    side.push(sidebarHeading('Education', spec));
    for (const ed of content.education) {
      side.push(
        new Paragraph({
          spacing: { after: 10 },
          children: [new TextRun({ text: ed.credential, bold: true, size: spec.sizes.eduCredential, color: spec.body })],
        })
      );
      const rest = [ed.institution, ed.dates].filter((p): p is string => Boolean(p && p.trim())).join(' | ');
      if (rest) {
        side.push(
          new Paragraph({
            spacing: { after: 60 },
            children: [new TextRun({ text: rest, size: spec.sizes.eduMeta, color: spec.dim })],
          })
        );
      }
    }
  }
  if (side.length === 0) {
    side.push(new Paragraph({ children: [new TextRun({ text: ' ', size: spec.sizes.skills })] }));
  }

  // Invisible-border table with a shaded sidebar cell — same structure the original
  // Template1/Template4 files use (7200 + 3360 dxa columns). It holds page 1 only; the
  // sidebar shading spans just this table, so page 2+ is clean full-width paper.
  const table = new Table({
    width: { size: 10560, type: WidthType.DXA },
    borders: NO_BORDERS,
    columnWidths: [7200, 3360],
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: 7200, type: WidthType.DXA },
            margins: { top: 0, bottom: 0, left: 0, right: 240 },
            children: main.length > 0 ? main : [new Paragraph({ children: [] })],
          }),
          new TableCell({
            width: { size: 3360, type: WidthType.DXA },
            shading: { type: ShadingType.CLEAR, fill: spec.sidebarFill },
            margins: { top: 60, bottom: 160, left: 200, right: 200 },
            children: side,
          }),
        ],
      }),
    ],
  });

  // Everything past the page-1 split continues FULL WIDTH after the table (page 2+),
  // with identical paragraph styling — only the column width changes.
  const tail: Paragraph[] = [];
  if (split.page1JobCount < content.experience.length) {
    tail.push(...jobParagraphs(content.experience.slice(split.page1JobCount), spec));
  }
  if (highlightItems.length > split.page1HighlightCount && content.highlight) {
    if (!split.page1HighlightHeading) tail.push(sectionHeading(content.highlight.heading, spec));
    tail.push(...highlightItemParagraphs(highlightItems.slice(split.page1HighlightCount), spec));
  }

  return [...headerParagraphs(content, spec), table, ...tail];
}

export async function buildResumeDocx(
  content: ResumeContent,
  style: ResumeStyle = DEFAULT_RESUME_STYLE
): Promise<Blob> {
  const spec = getTemplateSpec(style);
  const children =
    spec.layout === 'two-column'
      ? buildTwoColumnChildren(content, spec)
      : buildEditorialChildren(content, spec);

  const doc = new Document({
    sections: [
      {
        properties: { page: { margin: spec.margins } },
        children,
      },
    ],
    styles: {
      default: {
        document: {
          // Arial and Georgia ship with Windows and macOS, so the file opens with the
          // intended look on any machine — no embedded/exotic fonts.
          run: { font: spec.font },
        },
      },
    },
  });

  return Packer.toBlob(doc);
}

/** Triggers a browser download of the given blob — no server round-trip, matching the
 * in-browser rendering requirement in SPEC.md §6/§9. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Twips (the unit spec.margins uses, matching the .docx section margins) → CSS inches. */
export function twipsToIn(twips: number): string {
  return `${twips / 1440}in`;
}

/** Per-layout @page rule so the printed PDF gets the same page margins as its .docx
 * sibling (0.5in all around for two-column; 0.375in top/bottom + 0.5in sides for
 * editorial). Emitted with the print HTML because @page can't be scoped by class in
 * global.css. */
function pageMarginStyle(spec: TemplateSpec): string {
  const m = spec.margins;
  return `<style>@media print { @page { margin: ${twipsToIn(m.top)} ${twipsToIn(m.right)} ${twipsToIn(m.bottom)} ${twipsToIn(m.left)}; } }</style>`;
}

/** Inline CSS custom properties that carry the palette into global.css's layout rules —
 * one set of print rules per LAYOUT, colored by these variables. */
function paletteStyleAttr(spec: TemplateSpec): string {
  return `--rp-accent:#${spec.accent};--rp-soft:#${spec.accentSoft};--rp-fill:#${spec.sidebarFill};`;
}

function jobsHtml(jobs: Job[], editorial: boolean): string {
  return jobs
    .map((job) => {
      const metaParts = [job.company, job.dates, job.location].filter((p): p is string => Boolean(p && p.trim()));
      const metaText = editorial
        ? [metaParts[0]?.toUpperCase() ?? '', ...metaParts.slice(1)].filter(Boolean).join('   |   ')
        : metaParts.join('  |  ');
      return `
        <div class="resume-print-job">
          <p class="resume-print-job-title">${escapeHtml(job.title)}</p>
          ${metaText ? `<p class="resume-print-job-meta">${escapeHtml(metaText)}</p>` : ''}
          <ul>${job.bullets.filter((b) => b.trim()).map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>
        </div>`;
    })
    .join('');
}

function highlightItemsHtml(items: HighlightItem[]): string {
  return items
    .map(
      (it) => `
        <div class="resume-print-highlight">
          <p class="resume-print-highlight-title">${escapeHtml(it.title)}</p>
          ${it.body.trim() ? `<p class="resume-print-highlight-body">${escapeHtml(it.body)}</p>` : ''}
        </div>`
    )
    .join('');
}

/** Renders the same content as print-ready HTML for the "Save as PDF" flow (window.print()
 * with a @media print stylesheet — no server-side PDF generation). The `tpl-<layout>` class
 * plus the inline palette variables select the matching styles in global.css so the printed
 * PDF mirrors the .docx output for the same layout+color. */
export function renderResumePrintHtml(
  content: ResumeContent,
  style: ResumeStyle = DEFAULT_RESUME_STYLE
): string {
  const spec = getTemplateSpec(style);
  const contact = contactLine(content);
  const editorial = spec.layout === 'editorial';
  const rootAttrs = `id="resume-print-root" class="tpl-${spec.layout}" style="${paletteStyleAttr(spec)}"`;

  const educationHtml = content.education
    .map((ed) => {
      const rest = [ed.institution, ed.dates].filter((p): p is string => Boolean(p && p.trim())).join(' | ');
      return `<p class="resume-print-ed"><strong>${escapeHtml(ed.credential)}</strong>${rest ? `  |  ${escapeHtml(rest)}` : ''}</p>`;
    })
    .join('');

  const certifications = content.certifications ?? [];
  const certificationsHtml = certifications
    .map((cert) => {
      const rest = [cert.issuer, cert.date].filter((p): p is string => Boolean(p && p.trim())).join(' | ');
      return `<p class="resume-print-ed"><strong>${escapeHtml(cert.name)}</strong>${rest ? `  |  ${escapeHtml(rest)}` : ''}</p>`;
    })
    .join('');

  const headerHtml = `
      <div class="resume-print-header">
        <h1>${escapeHtml(content.contact.name ?? 'Candidate Name')}</h1>
        ${contact ? `<p class="resume-print-contact">${escapeHtml(contact)}</p>` : ''}
      </div>`;

  const highlightItems = validHighlightItems(content);
  const heading = content.highlight?.heading ?? '';

  if (editorial) {
    return `
    ${pageMarginStyle(spec)}
    <div ${rootAttrs}>
      ${headerHtml}
      ${content.summary ? `<h2>Profile</h2><p class="resume-print-summary">${escapeHtml(content.summary)}</p>` : ''}
      ${content.experience.length ? `<h2>Professional Experience</h2>${jobsHtml(content.experience, editorial)}` : ''}
      ${highlightItems.length ? `<h2>${escapeHtml(heading)}</h2>${highlightItemsHtml(highlightItems)}` : ''}
      ${content.skills.length ? `<h2>Skills</h2><p>${escapeHtml(content.skills.join('  •  '))}</p>` : ''}
      ${certifications.length ? `<h2>Certifications &amp; Clearance</h2>${certificationsHtml}` : ''}
      ${content.education.length ? `<h2>Education</h2>${educationHtml}` : ''}
    </div>
  `;
  }

  const sidebarSkills = content.skills.length
    ? `<h3>Skills</h3>${content.skills.map((s) => `<p class="resume-print-skill">${escapeHtml(s)}</p>`).join('')}`
    : '';
  const sidebarCertifications = certifications.length
    ? `<h3>Certifications &amp; Clearance</h3>${certifications
        .map((cert) => {
          const rest = [cert.issuer, cert.date].filter((p): p is string => Boolean(p && p.trim())).join(' | ');
          return `<p class="resume-print-ed"><strong>${escapeHtml(cert.name)}</strong></p>${rest ? `<p class="resume-print-ed-meta">${escapeHtml(rest)}</p>` : ''}`;
        })
        .join('')}`
    : '';
  const sidebarEducation = content.education.length
    ? `<h3>Education</h3>${content.education
        .map((ed) => {
          const rest = [ed.institution, ed.dates].filter((p): p is string => Boolean(p && p.trim())).join(' | ');
          return `<p class="resume-print-ed"><strong>${escapeHtml(ed.credential)}</strong></p>${rest ? `<p class="resume-print-ed-meta">${escapeHtml(rest)}</p>` : ''}`;
        })
        .join('')}`
    : '';

  // Mirror the docx page-1 split: the grid holds the page-1 chunk beside the sidebar,
  // everything past the split continues full width below it.
  const split = splitTwoColumnContent(content);
  const page1Highlight =
    split.page1HighlightHeading && split.page1HighlightCount > 0
      ? `<h2>${escapeHtml(heading)}</h2>${highlightItemsHtml(highlightItems.slice(0, split.page1HighlightCount))}`
      : '';
  const tailJobs = content.experience.slice(split.page1JobCount);
  const tailItems = highlightItems.slice(split.page1HighlightCount);
  const tailHtml =
    tailJobs.length || tailItems.length
      ? `
      <div class="resume-print-fullwidth">
        ${tailJobs.length ? jobsHtml(tailJobs, editorial) : ''}
        ${tailItems.length ? `${split.page1HighlightHeading ? '' : `<h2>${escapeHtml(heading)}</h2>`}${highlightItemsHtml(tailItems)}` : ''}
      </div>`
      : '';

  return `
    ${pageMarginStyle(spec)}
    <div ${rootAttrs}>
      ${headerHtml}
      <div class="resume-print-columns">
        <div class="resume-print-main">
          ${content.summary ? `<h2>Summary</h2><p class="resume-print-summary">${escapeHtml(content.summary)}</p>` : ''}
          ${content.experience.length ? `<h2>Experience</h2>${jobsHtml(content.experience.slice(0, split.page1JobCount), editorial)}` : ''}
          ${page1Highlight}
        </div>
        <div class="resume-print-side">
          ${sidebarSkills}
          ${sidebarCertifications}
          ${sidebarEducation}
        </div>
      </div>
      ${tailHtml}
    </div>
  `;
}
