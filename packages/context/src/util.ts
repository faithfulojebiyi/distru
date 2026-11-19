/** Small deterministic helpers shared by sync, profile, memory and onboarding. */

/** Structurally compatible with `@ops/harness`'s `Clock` and `FakeClock`. */
export interface ContextClock {
  now(): Date;
  sleep?(ms: number): Promise<void>;
}

export const systemClock: ContextClock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export const DAY_MS = 86_400_000;
export const MINUTE_MS = 60_000;

export const iso = (d: Date | number): string => new Date(d).toISOString();

export function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function round(n: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function sum(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

export function mean(xs: readonly number[]): number | null {
  return xs.length ? sum(xs) / xs.length : null;
}

/** Linear-interpolated percentile (p in 0..100). */
export function percentile(xs: readonly number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo]! + (s[hi]! - s[lo]!) * (idx - lo);
}

export const median = (xs: readonly number[]): number | null => percentile(xs, 50);

export const pctChange = (now: number, before: number): number | null => (before === 0 ? null : round(((now - before) / before) * 100, 1));

/** FNV-1a 32-bit, hex. Deterministic ids for memories (dedupe by content key). */
export function hashId(...parts: (string | null | undefined)[]): string {
  let h = 0x811c9dc5;
  const s = parts.map((p) => p ?? '').join('\u0000');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** ERP free text is untrusted: one line, no control chars, clamped. Used for names in LLM context. */
export function safeLabel(v: string | null | undefined, max = 60): string {
  if (!v) return '';
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function uniq<T>(xs: Iterable<T>): T[] {
  return [...new Set(xs)];
}

export function groupBy<T, K>(xs: readonly T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = m.get(k);
    if (list) list.push(x);
    else m.set(k, [x]);
  }
  return m;
}

export const money = (n: number): string => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: n % 1 === 0 ? 0 : 2 })}`;
