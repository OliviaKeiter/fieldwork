import type { IconComponent } from './icons';
import { hashSeed, mulberry32 } from '../lib/starfield';

/** The one empty state in the app.
 *
 * An empty screen is the first thing a new self-hoster sees on almost every
 * page, so it gets a real shape: a muted icon, a short line saying what belongs
 * here, and (where there is one) the action that fills it — set against a faint
 * scatter of stars, because in Fieldwork an empty screen is just sky that
 * hasn't been charted yet. */

/* Deterministic scatter (seeded, not Math.random) so the server render and the
   hydrated client agree pixel-for-pixel, and the sky doesn't reshuffle between
   visits. Colors are theme variables, so it whispers in light mode too. */
const SCATTER = (() => {
  const rng = mulberry32(hashSeed('empty-sky'));
  const colors = ['var(--text-dim)', 'var(--accent)', 'var(--accent-2)'];
  const dots = Array.from({ length: 30 }, () => ({
    cx: rng() * 400,
    cy: rng() * 240,
    r: 0.7 + rng() * 1.1,
    fill: colors[Math.floor(rng() * colors.length)],
    opacity: 0.07 + rng() * 0.13,
  }));
  // One small constellation in the upper-right, slightly brighter than the
  // scatter — the hint that this sky is waiting for its stars.
  const anchor = { x: 300, y: 44 };
  const constellation = Array.from({ length: 4 }, () => ({
    cx: anchor.x + (rng() - 0.5) * 110,
    cy: anchor.y + (rng() - 0.5) * 60,
  }));
  return { dots, constellation };
})();

export default function EmptyState({
  Icon,
  title,
  body,
  action,
}: {
  Icon: IconComponent;
  title: string;
  body: string;
  action?: { label: string; href: string };
}) {
  return (
    <div className="relative flex flex-col items-center justify-center overflow-hidden rounded-xl border border-dashed border-border bg-surface px-6 py-16 text-center">
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full"
        viewBox="0 0 400 240"
        preserveAspectRatio="xMidYMid slice"
      >
        {SCATTER.dots.map((dot, i) => (
          <circle key={i} cx={dot.cx} cy={dot.cy} r={dot.r} fill={dot.fill} opacity={dot.opacity} />
        ))}
        {SCATTER.constellation.map((dot, i) => {
          const next = SCATTER.constellation[i + 1];
          return next ? (
            <line
              key={`l${i}`}
              x1={dot.cx}
              y1={dot.cy}
              x2={next.cx}
              y2={next.cy}
              stroke="var(--text-dim)"
              strokeWidth="0.5"
              opacity="0.14"
            />
          ) : null;
        })}
        {SCATTER.constellation.map((dot, i) => (
          <circle key={`c${i}`} cx={dot.cx} cy={dot.cy} r="1.4" fill="var(--accent)" opacity="0.3" />
        ))}
      </svg>
      <span
        aria-hidden="true"
        className="relative flex h-11 w-11 items-center justify-center rounded-xl bg-surface-2 text-text-dim"
      >
        <Icon className="h-5 w-5" />
      </span>
      <p className="relative mt-4 text-sm font-medium text-text">{title}</p>
      <p className="relative mt-1.5 max-w-sm text-sm text-text-dim">{body}</p>
      {action && (
        <a
          href={action.href}
          className="relative mt-5 rounded-lg bg-accent px-3.5 py-2 text-xs font-medium text-bg transition-opacity hover:opacity-90"
        >
          {action.label}
        </a>
      )}
    </div>
  );
}
