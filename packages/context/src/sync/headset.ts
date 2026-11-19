/**
 * Headset (retail sell-through) → `facts`. Headset keys products by SKU, so facts use
 * `entity_type = 'product'`, `entity_key = <sku>`; the profile joins them to Distru products by SKU.
 * Accepts the `trends()` rows of `@ops/connector-headset` (validated here, not imported, so the
 * context layer has no dependency on that connector).
 */
import { z } from 'zod';
import type { Fact } from '../model';
import type { ContextStore } from '../store';

export const HEADSET_SOURCE = 'headset';

export const HeadsetTrendRowIn = z.object({
  sku: z.string(),
  has_data: z.boolean().optional(),
  units_last_4w: z.number().nullish(),
  units_prior_4w: z.number().nullish(),
  units_wow_pct: z.number().nullish(),
  units_growth_3w_pct: z.number().nullish(),
  wow_pct: z.number().nullish(),
  growth_3w_pct: z.number().nullish(),
  stores_carrying: z.number().nullish(),
  stores_carrying_4w_ago: z.number().nullish(),
  oos_days_last_3w: z.number().nullish(),
  weekly: z.array(z.object({ week_start: z.string(), units: z.number(), revenue: z.number().optional(), stores_carrying: z.number().optional() })).optional(),
});
export type HeadsetTrendRowIn = z.infer<typeof HeadsetTrendRowIn>;

const SCALAR_METRICS = [
  'units_last_4w',
  'units_prior_4w',
  'units_wow_pct',
  'units_growth_3w_pct',
  'wow_pct',
  'growth_3w_pct',
  'stores_carrying',
  'stores_carrying_4w_ago',
  'oos_days_last_3w',
] as const;

/** Converts Headset trend rows into facts (scalar metrics at `observedAt`, weekly units per week). */
export function headsetTrendFacts(rows: readonly unknown[], observedAt: string): Fact[] {
  const facts: Fact[] = [];
  for (const raw of rows) {
    const row = HeadsetTrendRowIn.parse(raw);
    if (row.has_data === false) continue;
    for (const metric of SCALAR_METRICS) {
      const value = row[metric];
      if (typeof value === 'number' && Number.isFinite(value)) facts.push({ source: HEADSET_SOURCE, entityType: 'product', entityKey: row.sku, metric, value, observedAt });
    }
    for (const w of row.weekly ?? []) {
      const at = new Date(`${w.week_start.slice(0, 10)}T00:00:00Z`).toISOString();
      facts.push({ source: HEADSET_SOURCE, entityType: 'product', entityKey: row.sku, metric: 'units_week', value: w.units, observedAt: at });
      if (typeof w.revenue === 'number') facts.push({ source: HEADSET_SOURCE, entityType: 'product', entityKey: row.sku, metric: 'revenue_week', value: w.revenue, observedAt: at });
    }
  }
  return facts;
}

/** Ingests Headset trend rows into the unified layer. Idempotent per (sku, metric, observedAt). */
export async function ingestHeadsetTrends(store: ContextStore, rows: readonly unknown[], opts: { observedAt: string }): Promise<{ facts: number; skus: number }> {
  const facts = headsetTrendFacts(rows, opts.observedAt);
  await store.appendFacts(facts);
  return { facts: facts.length, skus: new Set(facts.map((f) => f.entityKey)).size };
}

/** Generic ingestion for any connector that produces facts (email signals, spreadsheets, ...). */
export async function ingestFacts(store: ContextStore, facts: readonly unknown[]): Promise<number> {
  const parsed = facts.map((f) => FactIn.parse(f));
  return store.appendFacts(parsed);
}

const FactIn = z.object({
  source: z.string().min(1),
  entityType: z.string().min(1),
  entityKey: z.string().min(1),
  metric: z.string().min(1),
  value: z.number(),
  observedAt: z.string(),
});
