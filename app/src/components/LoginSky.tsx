import { useEffect, useRef } from 'react';
import { drawStar, hashSeed, makeAmbientStars, mulberry32, project, type Star } from '../lib/starfield';

/* The first thing anyone sees: a slow, many-colored little universe behind the
 * sign-in card. Pure ambience — no data, no interaction, pointer-events none —
 * built on the same engine as the Constellation so the app opens and closes on
 * the same sky. Honors prefers-reduced-motion by rendering a single still frame. */

const DARK_COLORS = ['#e08a3c', '#e5b54e', '#8fae6c', '#79c2a5', '#f1ece3', '#c65b4a', '#8494a8'];
const LIGHT_COLORS = ['#c9702f', '#a8862e', '#5f7a53', '#3f8a72', '#8d6b4a', '#b04a3a', '#5c6d80'];

function makeSky(colors: string[], dim: number): Star[] {
  // A fuller, nearer scatter than the Constellation's backdrop — this IS the scene.
  const stars: Star[] = [];
  for (let i = 0; i < 190; i++) {
    const rng = mulberry32(hashSeed(`login-${i}`));
    const theta = rng() * Math.PI * 2;
    const phi = Math.acos(2 * rng() - 1);
    const r = 0.35 + rng() * 1.05;
    stars.push({
      x: r * Math.sin(phi) * Math.cos(theta),
      y: r * Math.cos(phi),
      z: r * Math.sin(phi) * Math.sin(theta),
      size: 0.8 + rng() * 1.7,
      color: colors[Math.floor(rng() * colors.length)],
      alpha: (0.12 + rng() * 0.4) * dim,
      twinklePhase: rng() * Math.PI * 2,
      twinkleSpeed: 0.4 + rng() * 1.1,
    });
  }
  return stars;
}

export default function LoginSky() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const light = document.documentElement.getAttribute('data-theme') === 'light';
    // Light theme keeps the sky but whispers it, so the card stays the subject.
    const stars = makeSky(light ? LIGHT_COLORS : DARK_COLORS, light ? 0.55 : 1);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let width = 0;
    let height = 0;
    const resize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    /* Shooting stars: rare, quick, gone. One streaks by every 6–14 seconds —
       often enough to catch while typing an email, never often enough to be
       a light show. */
    interface Meteor {
      x: number;
      y: number;
      vx: number; // px per ms
      vy: number;
      born: number;
      life: number;
    }
    let meteors: Meteor[] = [];
    let nextMeteorAt = 0;
    const spawnMeteor = (t: number) => {
      const goingRight = Math.random() > 0.5;
      const angle = (20 + Math.random() * 18) * (Math.PI / 180);
      const speed = 0.55 + Math.random() * 0.35;
      meteors.push({
        x: width * (goingRight ? 0.05 + Math.random() * 0.4 : 0.55 + Math.random() * 0.4),
        y: height * (0.05 + Math.random() * 0.3),
        vx: Math.cos(angle) * speed * (goingRight ? 1 : -1),
        vy: Math.sin(angle) * speed,
        born: t,
        life: 600 + Math.random() * 350,
      });
      nextMeteorAt = t + 6000 + Math.random() * 8000;
    };

    let raf = 0;
    let drawnOnce = false;
    const draw = (t: number) => {
      // Reduced motion still deserves its one still frame, so keep asking for
      // frames until a draw actually lands (hidden/background tabs skip).
      if (!reduced || !drawnOnce) raf = requestAnimationFrame(draw);
      if (document.hidden) return;
      // A tab that loaded in the background hydrates at 0x0; catch up here.
      if (width === 0) resize();
      if (width === 0) return;
      drawnOnce = true;
      const spin = t / 22000; // one lazy revolution every ~2 minutes
      const radiusPx = Math.max(width, height) * 0.62;
      ctx.clearRect(0, 0, width, height);
      for (const star of stars) {
        const p = project(star, spin, 0.35, width / 2, height / 2, radiusPx);
        if (!p) continue;
        const tw = reduced
          ? 1
          : 0.7 + 0.3 * Math.sin((t / 1000) * star.twinkleSpeed + star.twinklePhase);
        drawStar(ctx, star, p, tw);
      }

      if (!reduced) {
        if (nextMeteorAt === 0) nextMeteorAt = t + 2500 + Math.random() * 4000;
        else if (t >= nextMeteorAt) spawnMeteor(t);
        meteors = meteors.filter((m) => t - m.born < m.life);
        const meteorTint = light ? '43, 38, 32' : '241, 236, 227';
        for (const m of meteors) {
          const age = t - m.born;
          const progress = age / m.life;
          const fade = Math.sin(Math.PI * progress); // ease in, ease out
          const hx = m.x + m.vx * age;
          const hy = m.y + m.vy * age;
          const tailMs = Math.min(age, 130);
          const tx = hx - m.vx * tailMs;
          const ty = hy - m.vy * tailMs;
          const grad = ctx.createLinearGradient(tx, ty, hx, hy);
          grad.addColorStop(0, `rgba(${meteorTint}, 0)`);
          grad.addColorStop(1, `rgba(${meteorTint}, ${0.75 * fade})`);
          ctx.strokeStyle = grad;
          ctx.lineWidth = 1.5;
          ctx.lineCap = 'round';
          ctx.globalAlpha = 1;
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(hx, hy);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 h-full w-full"
    />
  );
}
