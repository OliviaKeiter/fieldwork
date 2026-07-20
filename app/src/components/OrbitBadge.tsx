import { STATUS_COLOR, STATUS_RING } from '../lib/constellation';
import { STATUS_LABEL } from '../lib/pipeline';
import { hashSeed, mulberry32 } from '../lib/starfield';
import type { FwStatus } from '../lib/types';

/* A role's place in the sky, at a glance: the funnel's orbits in miniature
 * with this application's star glowing on its ring. Links to the Constellation,
 * where the same star lives among all the others. The star's angle is seeded
 * from the application id — the same trick the Constellation uses — so the
 * badge and the big sky agree that this star is *somewhere specific*. */

/** Innermost first, so "orbits from the core" is just the index. */
const ORBITS_IN: FwStatus[] = [
  'accepted',
  'offer',
  'final_round',
  'interviewing',
  'phone_screen',
  'applied',
  'to_apply',
];

const MAX_R = 26;

export default function OrbitBadge({ status, appId }: { status: FwStatus; appId: string }) {
  const ring = STATUS_RING[status];
  const isDust = ring === undefined;
  const angle = mulberry32(hashSeed(appId))() * Math.PI * 2;
  const r = (isDust ? 1.12 : ring) * MAX_R;
  const x = 32 + r * Math.cos(angle);
  const y = 32 + r * Math.sin(angle);
  const color = STATUS_COLOR[status];

  const label = isDust
    ? `${STATUS_LABEL[status]} — in the dust. Open the Constellation.`
    : status === 'accepted'
      ? 'Accepted — home. Open the Constellation.'
      : `${STATUS_LABEL[status]} — ${ORBITS_IN.indexOf(status)} ${
          ORBITS_IN.indexOf(status) === 1 ? 'orbit' : 'orbits'
        } from the core. Open the Constellation.`;

  return (
    <a
      href="/constellation"
      title={label}
      aria-label={label}
      className="group hidden shrink-0 rounded-full transition-opacity hover:opacity-80 sm:block"
    >
      <svg viewBox="0 0 64 64" className="h-12 w-12">
        {ORBITS_IN.map((s) => (
          <circle
            key={s}
            cx="32"
            cy="32"
            r={STATUS_RING[s]! * MAX_R}
            fill="none"
            stroke="var(--text-dim)"
            strokeWidth="0.6"
            opacity={s === status ? 0.5 : 0.16}
          />
        ))}
        {/* The core: where offers land. */}
        <circle cx="32" cy="32" r="2.2" fill="#f3d05f" opacity="0.35" />
        <circle cx="32" cy="32" r="1.1" fill="#f3d05f" opacity="0.8" />
        {/* This role's star, glow then core. */}
        <circle cx={x} cy={y} r="4.5" fill={color} opacity={isDust ? 0.15 : 0.3} />
        <circle cx={x} cy={y} r="2" fill={color} opacity={isDust ? 0.55 : 1} />
      </svg>
    </a>
  );
}
