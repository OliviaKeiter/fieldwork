import type { FwGrade } from '../lib/types';

export interface VerdictCardData {
  grade: FwGrade;
  comp_min: number | null;
  comp_max: number | null;
  remote_type: string | null;
  location: string | null;
  pain_line: string | null;
  gaps: string[];
  reasoning: string;
  liveness_note?: string | null;
}

/** Color + one-line gloss per grade. Per SPEC.md §7, whimsy never touches a bad grade: D and
 * F stay plain and factual — no cute copy, no icon, no commiseration. A low grade is
 * information about a posting, not a comment on the candidate, and the UI should read that
 * way. Only A+/A get a colour that celebrates. */
export const GRADE_META: Record<
  FwGrade,
  { gloss: string; border: string; bg: string; text: string }
> = {
  'A+': { gloss: 'Drop everything', border: 'border-success/50', bg: 'bg-success/15', text: 'text-success' },
  A: { gloss: 'Strong fit — apply', border: 'border-success/40', bg: 'bg-success/10', text: 'text-success' },
  B: { gloss: 'Worth it, with caveats', border: 'border-accent/40', bg: 'bg-accent/10', text: 'text-accent' },
  C: { gloss: 'A stretch', border: 'border-border', bg: 'bg-surface', text: 'text-text-dim' },
  D: { gloss: 'Weak fit', border: 'border-border', bg: 'bg-surface', text: 'text-text-dim' },
  F: { gloss: 'Skip', border: 'border-border', bg: 'bg-surface', text: 'text-text-dim' },
};

/** The letter itself, sized to be the first thing you see on the card. Exported so the
 * dossier renders the same badge rather than a second interpretation of the same grade. */
export function GradeBadge({ grade, small }: { grade: FwGrade; small?: boolean }) {
  const meta = GRADE_META[grade];
  return (
    <span
      aria-label={`Grade ${grade} — ${meta.gloss}`}
      className={`flex shrink-0 items-center justify-center rounded-lg border font-semibold tabular-nums ${
        meta.border
      } ${meta.bg} ${meta.text} ${small ? 'h-7 w-9 text-sm' : 'h-12 w-14 text-2xl'}`}
    >
      {grade}
    </span>
  );
}

function formatComp(min: number | null, max: number | null): string {
  if (min == null && max == null) return 'Not stated';
  if (min != null && max != null) return `$${min.toLocaleString()} – $${max.toLocaleString()}`;
  return `$${(min ?? max ?? 0).toLocaleString()}+`;
}

interface Props {
  card: VerdictCardData;
  heading: string;
  subheading?: string;
  onFile?: () => void;
  onDiscard?: () => void;
  filing?: boolean;
  filed?: boolean;
  discarded?: boolean;
}

export default function VerdictCardView({
  card,
  heading,
  subheading,
  onFile,
  onDiscard,
  filing,
  filed,
  discarded,
}: Props) {
  const meta = GRADE_META[card.grade];

  return (
    <div className={`rounded-xl border ${meta.border} ${meta.bg} p-4`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex gap-3">
          <GradeBadge grade={card.grade} />
          <div>
            <p className={`text-xs font-medium uppercase tracking-wide ${meta.text}`}>{meta.gloss}</p>
            <p className="mt-1 font-medium text-text">{heading}</p>
            {subheading && <p className="text-sm text-text-dim">{subheading}</p>}
          </div>
        </div>
        {!filed && !discarded && (onFile || onDiscard) && (
          <div className="flex shrink-0 gap-2">
            {onDiscard && (
              <button
                type="button"
                onClick={onDiscard}
                disabled={filing}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-dim transition-colors hover:text-text disabled:opacity-50"
              >
                Discard
              </button>
            )}
            {onFile && (
              <button
                type="button"
                onClick={onFile}
                disabled={filing}
                className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {filing ? 'Filing…' : 'File as to_apply'}
              </button>
            )}
          </div>
        )}
        {filed && <p className="shrink-0 text-xs font-medium text-success">Filed</p>}
        {discarded && <p className="shrink-0 text-xs text-text-dim">Discarded</p>}
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs uppercase tracking-wide text-text-dim">Comp</dt>
          <dd className="text-text">{formatComp(card.comp_min, card.comp_max)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-text-dim">Remote</dt>
          <dd className="text-text">{card.remote_type ?? 'Not stated'}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-text-dim">Location</dt>
          <dd className="text-text">{card.location ?? '—'}</dd>
        </div>
      </dl>

      {card.pain_line && <p className="mt-3 text-sm italic text-text-dim">"{card.pain_line}"</p>}

      {card.gaps.length > 0 && (
        <div className="mt-3">
          <p className="text-xs uppercase tracking-wide text-text-dim">Gaps</p>
          <ul className="mt-1 list-inside list-disc text-sm text-text">
            {card.gaps.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </div>
      )}

      {card.reasoning && <p className="mt-3 whitespace-pre-wrap text-sm text-text">{card.reasoning}</p>}

      {card.liveness_note && <p className="mt-3 text-xs text-text-dim">Liveness check: {card.liveness_note}</p>}
    </div>
  );
}
