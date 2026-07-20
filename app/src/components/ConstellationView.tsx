import { useEffect, useRef, useState } from 'react';
import { listApplications } from '../lib/applications';
import { STATUS_LABEL } from '../lib/pipeline';
import {
  drawStar,
  hashSeed,
  makeAmbientStars,
  mulberry32,
  project,
  type ProjectedStar,
  type Star,
} from '../lib/starfield';
import { STATUS_RING as RING, STATUS_COLOR, GRADE_SIZE } from '../lib/constellation';
import type { FwApplication, FwStatus } from '../lib/types';

type LoadState = 'loading' | 'ready' | 'error';

interface AppStar extends Star {
  app: FwApplication;
}

const LEGEND_ORDER: FwStatus[] = [
  'to_apply',
  'applied',
  'phone_screen',
  'interviewing',
  'final_round',
  'offer',
  'accepted',
  'rejected',
  'withdrawn',
  'ghosted',
  'passed',
];

const AMBIENT_COLORS = ['#f1ece3', '#cdbba1', '#8494a8'];

function buildStars(apps: FwApplication[]): AppStar[] {
  return apps.map((app) => {
    const rng = mulberry32(hashSeed(app.id));
    const theta = rng() * Math.PI * 2;
    const ring = RING[app.status];
    const isDust = ring === undefined;
    // Dust scatters wide and thick; active stars sit on their stage's orbit,
    // in a disc that thins toward the core.
    const r = isDust ? 1.14 + rng() * 0.38 : ring * (0.88 + rng() * 0.28);
    const thickness = isDust ? 0.3 : 0.05 + 0.13 * r;
    const size = GRADE_SIZE[app.grade ?? 'B'] ?? 2.5;
    return {
      x: r * Math.cos(theta),
      y: (rng() * 2 - 1) * thickness,
      z: r * Math.sin(theta),
      size: isDust ? size * 0.72 : size,
      color: STATUS_COLOR[app.status],
      alpha: isDust ? 0.34 : 0.95,
      twinklePhase: rng() * Math.PI * 2,
      twinkleSpeed: 0.5 + rng() * 1.3,
      app,
    };
  });
}

export default function ConstellationView() {
  const [state, setState] = useState<LoadState>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [apps, setApps] = useState<FwApplication[]>([]);
  const [hovered, setHovered] = useState<{ app: FwApplication; x: number; y: number } | null>(
    null
  );
  const [focusStatus, setFocusStatus] = useState<FwStatus | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const starsRef = useRef<AppStar[]>([]);
  const ambientRef = useRef<Star[]>([]);
  const projRef = useRef<(ProjectedStar | null)[]>([]);
  const hoverRef = useRef(-1);
  const focusRef = useRef<FwStatus | null>(null);
  /* Everything the render loop mutates lives in one ref so React re-renders
     never restart or fight the animation. */
  const sceneRef = useRef({
    spin: 0.6,
    tilt: 0.5,
    zoom: 1,
    spinVel: 0,
    tiltVel: 0,
    dragging: false,
    lastX: 0,
    lastY: 0,
    downX: 0,
    downY: 0,
    moved: false,
    idleAt: 0,
  });

  useEffect(() => {
    focusRef.current = focusStatus;
  }, [focusStatus]);

  useEffect(() => {
    (async () => {
      try {
        const rows = await listApplications();
        setApps(rows);
        starsRef.current = buildStars(rows);
        setState('ready');
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Could not load applications.');
        setState('error');
      }
    })();
  }, []);

  /* The render loop. Independent of load state — the ambient universe runs
     while the data is on its way, and the galaxy fades in when stars land. */
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ambientRef.current = makeAmbientStars(150, AMBIENT_COLORS);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let width = 0;
    let height = 0;
    const resize = () => {
      const rect = container.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    let raf = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden || width === 0) return;
      const sc = sceneRef.current;

      if (!sc.dragging) {
        sc.spin += sc.spinVel;
        sc.tilt = Math.min(1.25, Math.max(0.06, sc.tilt + sc.tiltVel));
        sc.spinVel *= 0.95;
        sc.tiltVel *= 0.9;
        // Resume the slow idle turn a beat after the user lets go.
        if (!reduced && t - sc.idleAt > 1600) sc.spin += 0.0016;
      }

      const cx = width / 2;
      const cy = height / 2;
      const radiusPx = Math.min(width, height) * 0.42 * sc.zoom;
      ctx.clearRect(0, 0, width, height);

      // Orbit guides — faint, but they make the funnel legible.
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(241, 236, 227, 0.05)';
      for (const ring of Object.values(RING)) {
        ctx.beginPath();
        let started = false;
        for (let i = 0; i <= 64; i++) {
          const a = (i / 64) * Math.PI * 2;
          const p = project(
            { x: ring * Math.cos(a), y: 0, z: ring * Math.sin(a) },
            sc.spin,
            sc.tilt,
            cx,
            cy,
            radiusPx
          );
          if (!p) {
            started = false;
            continue;
          }
          if (started) ctx.lineTo(p.sx, p.sy);
          else ctx.moveTo(p.sx, p.sy);
          started = true;
        }
        ctx.stroke();
      }

      // The core: where offers land. It breathes, gently.
      const coreR = radiusPx * 0.085 * (1 + (reduced ? 0 : 0.06 * Math.sin(t / 900)));
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 2.4);
      core.addColorStop(0, 'rgba(255, 240, 200, 0.85)');
      core.addColorStop(0.25, 'rgba(243, 208, 95, 0.35)');
      core.addColorStop(1, 'rgba(243, 208, 95, 0)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR * 2.4, 0, Math.PI * 2);
      ctx.fill();

      for (const star of ambientRef.current) {
        const p = project(star, sc.spin * 0.4, sc.tilt * 0.5, cx, cy, radiusPx);
        if (!p) continue;
        const tw = reduced
          ? 1
          : 0.7 + 0.3 * Math.sin((t / 1000) * star.twinkleSpeed + star.twinklePhase);
        drawStar(ctx, star, p, tw);
      }

      // Project every galaxy star, remember screen positions for picking,
      // then paint far-to-near so overlaps stack correctly.
      const stars = starsRef.current;
      const projections: (ProjectedStar | null)[] = new Array(stars.length);
      const order: number[] = [];
      for (let i = 0; i < stars.length; i++) {
        const p = project(stars[i], sc.spin, sc.tilt, cx, cy, radiusPx);
        projections[i] = p;
        if (p) order.push(i);
      }
      order.sort((a, b) => projections[a]!.s - projections[b]!.s);
      projRef.current = projections;

      const focus = focusRef.current;
      const hoveredIdx = hoverRef.current;
      for (const i of order) {
        const star = stars[i];
        const p = projections[i]!;
        const tw = reduced
          ? 1
          : 0.75 + 0.25 * Math.sin((t / 1000) * star.twinkleSpeed + star.twinklePhase);
        const focusMul = focus === null ? 1 : star.app.status === focus ? 1.3 : 0.1;
        drawStar(ctx, star, p, tw * focusMul);
      }

      // Hover: ring the star and sketch its constellation — thin lines to its
      // nearest same-stage siblings.
      if (hoveredIdx >= 0 && hoveredIdx < stars.length && projections[hoveredIdx]) {
        const star = stars[hoveredIdx];
        const p = projections[hoveredIdx]!;
        const siblings = stars
          .map((s, i) => ({ s, i }))
          .filter(({ s, i }) => i !== hoveredIdx && s.app.status === star.app.status)
          .map(({ s, i }) => ({
            i,
            d: (s.x - star.x) ** 2 + (s.y - star.y) ** 2 + (s.z - star.z) ** 2,
          }))
          .sort((a, b) => a.d - b.d)
          .slice(0, 10);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(241, 236, 227, 0.14)';
        ctx.lineWidth = 1;
        for (const sib of siblings) {
          const sp = projections[sib.i];
          if (!sp) continue;
          ctx.beginPath();
          ctx.moveTo(p.sx, p.sy);
          ctx.lineTo(sp.sx, sp.sy);
          ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(241, 236, 227, 0.8)';
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, star.size * p.s * 2.6, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(loop);

    // Zoom needs preventDefault, which means a non-passive listener.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const sc = sceneRef.current;
      sc.zoom = Math.min(2.4, Math.max(0.45, sc.zoom * (e.deltaY > 0 ? 0.92 : 1.08)));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('wheel', onWheel);
      ro.disconnect();
    };
  }, []);

  function pick(offsetX: number, offsetY: number): number {
    const stars = starsRef.current;
    const projections = projRef.current;
    let best = -1;
    let bestS = 0;
    for (let i = 0; i < stars.length; i++) {
      const p = projections[i];
      if (!p) continue;
      const hitR = Math.max(11, stars[i].size * p.s * 3);
      const dx = p.sx - offsetX;
      const dy = p.sy - offsetY;
      if (dx * dx + dy * dy <= hitR * hitR && p.s > bestS) {
        best = i;
        bestS = p.s;
      }
    }
    return best;
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const sc = sceneRef.current;
    sc.dragging = true;
    sc.moved = false;
    sc.lastX = sc.downX = e.clientX;
    sc.lastY = sc.downY = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const sc = sceneRef.current;
    if (sc.dragging) {
      const dx = e.clientX - sc.lastX;
      const dy = e.clientY - sc.lastY;
      sc.lastX = e.clientX;
      sc.lastY = e.clientY;
      sc.spin += dx * 0.005;
      sc.tilt = Math.min(1.25, Math.max(0.06, sc.tilt + dy * 0.004));
      sc.spinVel = dx * 0.0022;
      sc.tiltVel = dy * 0.0015;
      if (Math.abs(e.clientX - sc.downX) + Math.abs(e.clientY - sc.downY) > 5) sc.moved = true;
      if (hoverRef.current !== -1) {
        hoverRef.current = -1;
        setHovered(null);
      }
      return;
    }
    const { offsetX, offsetY } = e.nativeEvent;
    const idx = pick(offsetX, offsetY);
    if (idx !== hoverRef.current) {
      hoverRef.current = idx;
      setHovered(
        idx >= 0 ? { app: starsRef.current[idx].app, x: offsetX, y: offsetY } : null
      );
    } else if (idx >= 0) {
      setHovered({ app: starsRef.current[idx].app, x: offsetX, y: offsetY });
    }
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    const sc = sceneRef.current;
    const wasDrag = sc.moved;
    sc.dragging = false;
    sc.idleAt = performance.now();
    if (!wasDrag) {
      const idx = pick(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
      if (idx >= 0) window.location.href = `/company?id=${starsRef.current[idx].app.id}`;
    }
  }

  function onPointerLeave() {
    sceneRef.current.dragging = false;
    hoverRef.current = -1;
    setHovered(null);
  }

  if (state === 'error') {
    return (
      <div className="rounded-xl border border-border bg-surface p-6 text-sm text-danger">
        {errorMessage}
      </div>
    );
  }

  const activeCount = apps.filter((a) => RING[a.status] !== undefined).length;
  const dustCount = apps.length - activeCount;
  const legend = LEGEND_ORDER.map((status) => ({
    status,
    count: apps.filter((a) => a.status === status).length,
  })).filter((entry) => entry.count > 0);

  return (
    <div
      ref={containerRef}
      className="relative h-[calc(100vh-14rem)] min-h-[30rem] overflow-hidden rounded-xl border border-border"
      /* The sky stays dark in both themes on purpose: it is a window, not a
         surface. Light mode gets a night sky through a bright frame. */
      style={{
        background:
          'radial-gradient(120% 100% at 50% 28%, #1e1826 0%, #171219 48%, #100d11 100%)',
      }}
    >
      <canvas
        ref={canvasRef}
        className={hovered ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
      />

      {/* Status line + controls hint. Fixed light-on-dark colors to match the sky. */}
      <div className="pointer-events-none absolute left-4 top-4 max-w-xs">
        <p className="text-sm font-medium text-[#f1ece3]">
          {state === 'loading'
            ? 'Charting the sky…'
            : `${activeCount} ${activeCount === 1 ? 'star' : 'stars'} in orbit${
                dustCount > 0 ? ` · ${dustCount} in the dust` : ''
              }`}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-[#a89c8c]">
          Drag to spin, scroll to zoom, click a star to open its dossier. The closer to the
          core, the closer to an offer.
        </p>
      </div>

      {state === 'ready' && apps.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="pointer-events-auto max-w-sm rounded-xl border border-[#f1ece3]/10 bg-[#17131c]/80 p-6 text-center backdrop-blur-sm">
            <p className="text-sm font-medium text-[#f1ece3]">No stars yet.</p>
            <p className="mt-1.5 text-sm text-[#a89c8c]">
              Every role you track becomes a star, and it drifts toward the core as it moves
              through your pipeline.
            </p>
            <a
              href="/intake"
              className="mt-4 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-medium text-[#17140f] transition-opacity hover:opacity-90"
            >
              Score your first role
            </a>
          </div>
        </div>
      )}

      {legend.length > 0 && (
        <div
          className="absolute inset-x-0 bottom-0 flex flex-wrap gap-x-4 gap-y-1.5 px-4 pb-3 pt-8"
          style={{ background: 'linear-gradient(to top, rgba(16,13,17,0.9), transparent)' }}
          onMouseLeave={() => setFocusStatus(null)}
        >
          {legend.map(({ status, count }) => (
            <button
              key={status}
              type="button"
              onMouseEnter={() => setFocusStatus(status)}
              onFocus={() => setFocusStatus(status)}
              onBlur={() => setFocusStatus(null)}
              className={[
                'flex items-center gap-1.5 text-xs transition-opacity',
                focusStatus && focusStatus !== status ? 'opacity-40' : 'opacity-100',
              ].join(' ')}
              style={{ color: '#cfc5b6' }}
            >
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-full"
                style={{
                  backgroundColor: STATUS_COLOR[status],
                  boxShadow: `0 0 6px ${STATUS_COLOR[status]}`,
                }}
              />
              {STATUS_LABEL[status]}
              <span style={{ color: '#8d8272' }}>{count}</span>
            </button>
          ))}
        </div>
      )}

      {hovered && (
        <div
          className="pointer-events-none absolute z-10 max-w-[16rem] rounded-lg border border-[#f1ece3]/10 bg-[#211a28]/95 px-3 py-2 shadow-xl backdrop-blur-sm"
          style={{
            left: Math.min(hovered.x + 16, (containerRef.current?.clientWidth ?? 400) - 264),
            top: hovered.y + 16,
          }}
        >
          <p className="truncate text-sm font-medium text-[#f1ece3]">{hovered.app.company}</p>
          {hovered.app.title && (
            <p className="truncate text-xs text-[#a89c8c]">{hovered.app.title}</p>
          )}
          <p className="mt-1 flex items-center gap-1.5 text-xs" style={{ color: '#cfc5b6' }}>
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: STATUS_COLOR[hovered.app.status] }}
            />
            {STATUS_LABEL[hovered.app.status]}
            {hovered.app.grade && <span style={{ color: '#8d8272' }}>· {hovered.app.grade}</span>}
          </p>
        </div>
      )}
    </div>
  );
}
