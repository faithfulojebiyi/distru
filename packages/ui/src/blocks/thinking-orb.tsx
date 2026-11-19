import { useEffect, useRef, useState } from 'react';
import {
  MODE_FRAMES,
  resolvePreset,
  type Dot,
  type Line,
  type OrbState,
} from 'thinking-orbs/engine';

import { useTheme } from '../primitives/theme';

export type { OrbState };

type Rgb = [number, number, number];

/** Whose colours the orb wears: the agent's, or a skill category's under the composer. */
export type OrbTone = 'agent' | 'discover' | 'analyze' | 'review' | 'generate';

/**
 * Colours around the orb. The agent cycles rose → violet → periwinkle, after the AI mark's gradient; each skill
 * category keeps to its own hue. Light pages take deeper shades so near dots stay saturated against white.
 */
const PALETTES: Record<OrbTone, Record<'light' | 'dark', Rgb[]>> = {
  agent: {
    light: [
      [178, 52, 104],
      [106, 53, 214],
      [42, 91, 199],
    ],
    dark: [
      [240, 163, 189],
      [182, 144, 244],
      [138, 180, 255],
    ],
  },
  discover: {
    light: [
      [214, 82, 0],
      [239, 128, 32],
      [196, 62, 20],
    ],
    dark: [
      [255, 160, 87],
      [255, 196, 128],
      [255, 132, 92],
    ],
  },
  analyze: {
    light: [
      [194, 41, 138],
      [214, 64, 159],
      [160, 40, 160],
    ],
    dark: [
      [255, 141, 204],
      [244, 168, 222],
      [230, 140, 240],
    ],
  },
  review: {
    light: [
      [0, 133, 115],
      [18, 165, 148],
      [0, 112, 128],
    ],
    dark: [
      [11, 216, 182],
      [102, 230, 210],
      [80, 200, 230],
    ],
  },
  generate: {
    light: [
      [110, 86, 207],
      [130, 90, 230],
      [90, 80, 200],
    ],
    dark: [
      [186, 167, 255],
      [200, 170, 255],
      [160, 160, 255],
    ],
  },
};

/** How far the farthest dot fades toward the page, from 0 (none) to 1 (into the page). */
const MAX_FADE = 0.7;

const LABELS: Record<OrbState, string> = {
  working: 'Working…',
  searching: 'Searching…',
  solving: 'Solving…',
  listening: 'Listening…',
  connecting: 'Connecting…',
  weaving: 'Weaving…',
  composing: 'Writing…',
  breathing: 'Thinking…',
  shaping: 'Shaping…',
};

/** The palette colour at a point on the orb: a closed gradient by angle around the centre. */
const hueAt = (palette: Rgb[], x: number, y: number, centre: number): Rgb => {
  const turn = (Math.atan2(y - centre, x - centre) + Math.PI) / (2 * Math.PI);
  const scaled = turn * palette.length;
  const from = Math.floor(scaled) % palette.length;
  const to = (from + 1) % palette.length;
  const mix = scaled - Math.floor(scaled);
  const a = palette[from]!;
  const b = palette[to]!;

  return [
    a[0] + (b[0] - a[0]) * mix,
    a[1] + (b[1] - a[1]) * mix,
    a[2] + (b[2] - a[2]) * mix,
  ];
};

/**
 * The engine's depth ramp on a colour: `white` 0 is the nearest, fullest ink. Far dots fade toward the page,
 * white on light pages and black on dark ones, the way the library's own tint keeps its depth.
 */
const shade = (colour: Rgb, white: number, alpha: number, dark: boolean) => {
  // Far dots fade only part of the way, so the orb still reads at inline (20px) size.
  const w = Math.min(1, Math.max(0, white)) * MAX_FADE;
  const ramp = (c: number) =>
    Math.round(dark ? c * (1 - w) : c + (255 - c) * w);

  return `rgba(${ramp(colour[0])},${ramp(colour[1])},${ramp(colour[2])},${alpha})`;
};

const paint = (
  ctx: CanvasRenderingContext2D,
  frame: { dots: Dot[]; lines: Line[] },
  size: number,
  dark: boolean,
  tone: OrbTone,
) => {
  const palette = PALETTES[tone][dark ? 'dark' : 'light'];
  const centre = size / 2;

  for (const line of frame.lines) {
    const colour = hueAt(
      palette,
      (line.x1 + line.x2) / 2,
      (line.y1 + line.y2) / 2,
      centre,
    );

    ctx.strokeStyle = shade(colour, line.white, line.a ?? 1, dark);
    ctx.lineWidth = line.w;
    ctx.beginPath();
    ctx.moveTo(line.x1, line.y1);
    ctx.lineTo(line.x2, line.y2);
    ctx.stroke();
  }

  for (const dot of frame.dots) {
    ctx.fillStyle = shade(
      hueAt(palette, dot.x, dot.y, centre),
      dot.white,
      dot.a ?? 1,
      dark,
    );
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2);
    ctx.fill();
  }
};

const useReducedMotion = () => {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;

    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);

    update();
    query.addEventListener('change', update);

    return () => query.removeEventListener('change', update);
  }, []);

  return reduced;
};

/**
 * An agent's working indicator: a dotted orb animating what the agent is doing, in the agent's colours. Every orb
 * shares one clock, pauses offscreen or on a hidden tab, and holds one still frame for reduced motion.
 */
export const ThinkingOrb = ({
  state,
  size = 20,
  tone = 'agent',
  'aria-label': label,
}: {
  state: OrbState;
  tone?: OrbTone;
  /** 20 sits inline with text; 64 is the larger, avatar-scale design. */
  size?: 20 | 64;
  'aria-label'?: string;
}) => {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === 'dark';
  const reduced = useReducedMotion();

  useEffect(() => {
    const canvas = ref.current;

    if (!canvas) return;

    const dpr = Math.min(
      2,
      (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1,
    );

    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);

    const ctx = canvas.getContext('2d');

    if (!ctx) return;

    const { mode, speed, opts } = resolvePreset(state, size);
    const frameAt = MODE_FRAMES[mode];
    const draw = (seconds: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      paint(ctx, frameAt(size, seconds, opts), size, dark, tone);
    };

    if (reduced) {
      draw(0.6);

      return;
    }

    let raf = 0;
    let running = false;
    let visible = true;
    const loop = () => {
      draw((performance.now() / 1000) * speed);

      if (running) raf = requestAnimationFrame(loop);
    };
    const start = () => {
      if (running) return;

      running = true;
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };

    draw((performance.now() / 1000) * speed);

    const observer =
      typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver(([entry]) => {
            visible = Boolean(entry?.isIntersecting);

            if (visible && document.visibilityState !== 'hidden') start();
            else stop();
          })
        : null;

    observer?.observe(canvas);

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stop();
      else if (visible) start();
    };

    document.addEventListener('visibilitychange', onVisibility);

    if (!observer) start();

    return () => {
      stop();
      observer?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [state, size, dark, reduced, tone]);

  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={label ?? LABELS[state]}
      data-orb-state={state}
      style={{ width: size, height: size, display: 'block', flexShrink: 0 }}
    />
  );
};
