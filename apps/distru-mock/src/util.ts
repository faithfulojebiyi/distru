/** Trimmed decimal string: 12 → "12", 1.23456 → "1.2346". */
export function fmtNum(n: number, maxDecimals = 4): string {
  if (!Number.isFinite(n)) return '0';
  const s = n.toFixed(maxDecimals);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** Money: 2 decimals. */
export const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/** Distru inventory quantities: 9 decimals ("10.000000000"). */
export const qty9 = (n: number) => n.toFixed(9);

/** Report dates: M/D/YYYY (UTC). */
export function fmtDateMDY(d: Date): string {
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

export const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export const DAY_MS = 86_400_000;

export const startOfUtcDay = (d: Date) => new Date(Math.floor(d.getTime() / DAY_MS) * DAY_MS);
