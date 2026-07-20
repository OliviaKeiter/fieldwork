import { starSprite } from './starfield';
import { CELEBRATION_COLORS } from './constellation';

/* A burst of stars — Fieldwork's celebration. Not paper confetti: the same
 * glowing star sprites the Constellation is drawn with, thrown outward from
 * the moment that earned them (a card landing on Offer).
 *
 * Fire-and-forget: spawns its own fixed full-screen canvas, animates ~1.2s,
 * cleans up after itself. Honors prefers-reduced-motion by doing nothing —
 * a celebration should never be the reason someone feels motion-sick. */

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  spin: number;
}

const LIFE_MS = 1300;

export function starBurst(originX: number, originY: number, count = 64): void {
  if (typeof window === 'undefined') return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:60;';
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  document.body.appendChild(canvas);

  const particles: Particle[] = [];
  for (let i = 0; i < count; i++) {
    // Slight upward bias, like something tossed rather than detonated.
    const angle = Math.random() * Math.PI * 2;
    const speed = 2.2 + Math.random() * 5.5;
    particles.push({
      x: originX,
      y: originY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 2.4,
      size: 1.6 + Math.random() * 2.6,
      color: CELEBRATION_COLORS[Math.floor(Math.random() * CELEBRATION_COLORS.length)],
      spin: Math.random() * Math.PI * 2,
    });
  }

  const started = performance.now();
  const tick = (t: number) => {
    const age = t - started;
    if (age >= LIFE_MS) {
      canvas.remove();
      return;
    }
    requestAnimationFrame(tick);
    const fade = 1 - age / LIFE_MS;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.11; // gentle gravity
      p.vx *= 0.985;
      const r = p.size * (0.5 + 0.5 * fade);
      const half = r * 3;
      // Twinkle on the way down, so it reads as stars, not sparks.
      ctx.globalAlpha = fade * (0.7 + 0.3 * Math.sin(age / 60 + p.spin));
      ctx.drawImage(starSprite(p.color), p.x - half, p.y - half, half * 2, half * 2);
    }
    ctx.globalAlpha = 1;
  };
  requestAnimationFrame(tick);
}
