/* Shared 3D starfield engine for the Constellation view and the login-page sky.
 *
 * Deliberately dependency-free: a full WebGL scene graph (three.js et al) is
 * ~600KB of JS for what is, at Fieldwork's scale, a few hundred glowing dots.
 * A 2D canvas with a hand-rolled rotate-and-project loop renders the same
 * picture in a couple of kilobytes and one draw call per star.
 *
 * Positions are SEEDED from stable ids (application ids for the galaxy, index
 * for ambient skies), so a star keeps its place in the sky between visits —
 * the universe grows, it doesn't reshuffle.
 */

export interface Star {
  /** Unit-space position. The galaxy lives roughly inside |r| <= 1; ambient
   *  dust sits further out. */
  x: number;
  y: number;
  z: number;
  /** Core draw radius in CSS px at zero depth (perspective scales it). */
  size: number;
  color: string;
  alpha: number;
  twinklePhase: number;
  twinkleSpeed: number;
}

export interface ProjectedStar {
  sx: number;
  sy: number;
  /** Perspective scale: 1 at the center plane, <1 behind, >1 in front. */
  s: number;
}

/* --- Seeded randomness -------------------------------------------------- */

/** xmur3 string hash — turns an id into a 32-bit seed. */
export function hashSeed(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/** mulberry32 PRNG — tiny, fast, good enough for scattering stars. */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* --- Projection ---------------------------------------------------------- */

const FOV = 3.2;

/** Rotates a point around Y (spin) then X (tilt) and projects it to screen
 *  space. Returns null when the point falls behind the camera. */
export function project(
  star: { x: number; y: number; z: number },
  spin: number,
  tilt: number,
  cx: number,
  cy: number,
  radiusPx: number
): ProjectedStar | null {
  const cosA = Math.cos(spin);
  const sinA = Math.sin(spin);
  const x1 = star.x * cosA + star.z * sinA;
  const z1 = -star.x * sinA + star.z * cosA;

  const cosT = Math.cos(tilt);
  const sinT = Math.sin(tilt);
  const y1 = star.y * cosT - z1 * sinT;
  const z2 = star.y * sinT + z1 * cosT;

  if (z2 <= -FOV * 0.9) return null;
  const s = FOV / (FOV + z2);
  return { sx: cx + x1 * s * radiusPx, sy: cy + y1 * s * radiusPx, s };
}

/* --- Glow sprites --------------------------------------------------------- */

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const spriteCache = new Map<string, HTMLCanvasElement>();

/** A pre-rendered radial glow — bright near-white core falling off through the
 *  star's color to transparent. drawImage of a cached sprite is far cheaper
 *  than per-frame shadowBlur, which is what keeps a few hundred stars at 60fps. */
export function starSprite(color: string): HTMLCanvasElement {
  const cached = spriteCache.get(color);
  if (cached) return cached;

  const SIZE = 64;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const [r, g, b] = hexToRgb(color);
  const grad = ctx.createRadialGradient(SIZE / 2, SIZE / 2, 0, SIZE / 2, SIZE / 2, SIZE / 2);
  grad.addColorStop(0, 'rgba(255, 252, 244, 0.95)');
  grad.addColorStop(0.18, `rgba(${r}, ${g}, ${b}, 0.9)`);
  grad.addColorStop(0.45, `rgba(${r}, ${g}, ${b}, 0.25)`);
  grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SIZE, SIZE);
  spriteCache.set(color, canvas);
  return canvas;
}

/** Draws one star. `s` is the perspective scale from project(); twinkle is a
 *  0–1 brightness multiplier the caller derives from time (1 = steady). */
export function drawStar(
  ctx: CanvasRenderingContext2D,
  star: Star,
  p: ProjectedStar,
  twinkle = 1
): void {
  const r = star.size * p.s;
  // The sprite's glow halo extends well past the core, so draw at ~3x radius.
  const half = r * 3;
  ctx.globalAlpha = Math.min(1, star.alpha * twinkle * (0.35 + 0.65 * p.s));
  ctx.drawImage(starSprite(star.color), p.sx - half, p.sy - half, half * 2, half * 2);
}

/** Scatters ambient background stars on a far shell — the "rest of the
 *  universe" behind whatever the foreground is. Deterministic per index. */
export function makeAmbientStars(
  count: number,
  colors: string[],
  rMin = 1.7,
  rMax = 2.6
): Star[] {
  const stars: Star[] = [];
  for (let i = 0; i < count; i++) {
    const rng = mulberry32(hashSeed(`ambient-${i}`));
    const theta = rng() * Math.PI * 2;
    const phi = Math.acos(2 * rng() - 1);
    const r = rMin + rng() * (rMax - rMin);
    stars.push({
      x: r * Math.sin(phi) * Math.cos(theta),
      y: r * Math.cos(phi),
      z: r * Math.sin(phi) * Math.sin(theta),
      size: 0.6 + rng() * 0.9,
      color: colors[Math.floor(rng() * colors.length)],
      alpha: 0.05 + rng() * 0.12,
      twinklePhase: rng() * Math.PI * 2,
      twinkleSpeed: 0.4 + rng() * 1.2,
    });
  }
  return stars;
}
