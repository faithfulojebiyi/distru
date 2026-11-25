import { createDistruClient, createDistruClientFromEnv, type DistruClient, type DistruClientConfig } from '@ops/distru-client';
import type { ConnectorContext } from '@ops/harness';
import { z } from 'zod';

/** The context slice this connector needs: a Distru client at `ctx.connectors.distru`. */
/** `now` (optional) is the business clock for "today" defaults; tests and evals pin it. Default: the wall clock. */
export type DistruCtx = ConnectorContext<'distru', DistruClient> & { now?: () => Date };

/**
 * Builds the connector context from Distru credentials. Spread it into the app context:
 * `{ ...createDistruContext({ baseUrl, token }), tenantId }`, or merge `connectors` with others.
 *
 * Tip: for the harness executor pass `maxRetries: 0` so 429s surface to the harness, which retries
 * them with `distruErrorClassifier` (honouring Retry-After) and audits every retry as `op.retry`.
 */
export function createDistruContext(config: DistruClientConfig): DistruCtx {
  return { connectors: { distru: createDistruClient(config) } };
}

/** Same, from `DISTRU_BASE_URL` / `DISTRU_API_TOKEN` (defaults to the local mock). */
export function createDistruContextFromEnv(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<DistruClientConfig> = {},
): DistruCtx {
  return { connectors: { distru: createDistruClientFromEnv(env, overrides) } };
}

// ── numbers ──────────────────────────────────────────────────────────────────────────────────

/** Distru returns decimals as strings ("12.000000000"). Parsed and rounded to 3 dp; null when absent. */
export function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
}

export const num0 = (v: string | number | null | undefined): number => num(v) ?? 0;

export const money = (n: number): string =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;

export const isoDay = (v: string | null | undefined): string | null => (v ? v.slice(0, 10) : null);

/** Distru report dates come as `MM/DD/YYYY`; normalized to `YYYY-MM-DD` (ISO passes through). */
export function reportDate(v: string | null | undefined): string | null {
  if (!v) return null;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v.trim());
  if (us) return `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`;
  return isoDay(v);
}

// ── identifiers (names, SKUs) ────────────────────────────────────────────────────────────────

/** Names/SKUs are ERP-controlled too: passed through as identifiers, but single-line and capped. */
export function label(v: string | null | undefined, max = 120): string {
  const s = (v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export const RefSchema = z.object({ id: z.string(), name: z.string() });
export type Ref = z.infer<typeof RefSchema>;

export const IdList = z.array(z.string().min(1)).min(1).max(100);

/** Collects at most `limit` items and reports whether more existed. */
export function take<T>(items: readonly T[], limit: number): { items: T[]; truncated: boolean } {
  return { items: items.slice(0, limit), truncated: items.length > limit };
}

/** Own locations by id (names for tool outputs). */
export async function locationNames(client: DistruClient): Promise<Map<string, string>> {
  const locations = await client.listAll(client.listLocations, {});
  return new Map(locations.map((l) => [l.id, label(l.name)]));
}

/** Distru single-record responses type `data` as optional; a 2xx without it is a protocol error. */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Distru returned no data for ${what}`);
  return value;
}
