import { useEffect, useRef, useState } from 'react';

interface Props {
  /** Stage labels advanced through on a timer while the long call is awaited. */
  stages: string[];
  /** Flip to true when the awaited call resolves — the bar snaps to 100%. */
  done?: boolean;
}

/** How often the bar eases forward, in ms. */
const TICK_MS = 200;
/** How long each simulated stage lasts before advancing, in ms. */
const STAGE_MS = 6000;
/** The bar eases toward this ceiling and holds until `done` snaps it to 100. */
const HOLD_AT = 90;

/**
 * Simulated progress for a single long await (the edge functions report no real
 * progress). The bar eases toward ~90% and holds; the stage label advances every
 * few seconds. No numeric percentage is shown — the motion is the signal.
 */
export default function BuildProgress({ stages, done = false }: Props) {
  const [progress, setProgress] = useState(0);
  const [stageIndex, setStageIndex] = useState(0);
  const stagesCount = useRef(stages.length);
  stagesCount.current = stages.length;

  useEffect(() => {
    if (done) return;
    const bar = window.setInterval(() => {
      // Exponential ease: fast out of the gate, asymptotic toward the hold point.
      setProgress((p) => Math.min(HOLD_AT, p + (HOLD_AT - p) * 0.035 + 0.05));
    }, TICK_MS);
    const stage = window.setInterval(() => {
      setStageIndex((i) => Math.min(i + 1, stagesCount.current - 1));
    }, STAGE_MS);
    return () => {
      window.clearInterval(bar);
      window.clearInterval(stage);
    };
  }, [done]);

  const width = done ? 100 : progress;
  const label = stages[Math.min(stageIndex, stages.length - 1)] ?? 'Working…';

  return (
    <div className="flex flex-col gap-2" role="status" aria-live="polite">
      <p className="text-sm text-text-dim">{done ? 'Done.' : label}</p>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}
