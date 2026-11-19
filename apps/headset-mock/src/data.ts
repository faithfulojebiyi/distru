/**
 * Deterministic retail sell-through: 16 complete weeks (Mon–Sun) per SKU per store, anchored to the
 * week before `now`. Every number is a pure function of (scenario, sku, store, week): noise comes
 * from a hash of those keys, so results never depend on request order.
 *
 * Scenario trends (in-stock velocity = units per store-day on shelf):
 *   - SURGING            VAP-BD-1G, PRE-BD-1G: ×1.30/×1.45/×1.60 over the last 3 weeks (+45–52%), all 10 stores
 *   - SURGING_WHOLESALE_OK FLW-OGK-35: ×1.35/×1.55/×1.75 (≈ +55%); distru-mock has it comfortably
 *                        above its reorder point (~68 days of supply): the "Distru says fine" SKU
 *   - DECLINING          EDB-CHO-MS: −6%/week from week 8 (≈ −24% over 3 weeks)
 *   - OOS_RISING         EDB-GUM-WM: shelf stock-outs climb to 2/3/4 days a week per store over the
 *                        last 3 weeks; demand per in-stock day is flat, so raw units fall
 *   - DISCONTINUED       FLW-TW-35: sold through, off every shelf for the last 10 weeks
 */
import { CATALOG, STORES, type CatalogItem, type Store } from './catalog';

export const WEEKS = 16;
const DAY_MS = 86_400_000;

export const SCENARIOS = {
  default: { trends: true, data: true, description: 'Retail trends baked in: Blue Dream cart + pre-roll surging, OG Kush 3.5g surging while wholesale is fine, milk chocolate declining, watermelon gummies stocking out.' },
  clean: { trends: true, data: true, description: 'Same retail data as default (mirrors distru-mock scenario names).' },
  'failed-lab-test': { trends: true, data: true, description: 'Same retail data as default.' },
  'prompt-injection': { trends: true, data: true, description: 'Same retail data as default.' },
  'no-reorder-needed': { trends: false, data: true, description: 'Flat retail demand everywhere: no surges, declines or stock-out trends.' },
  'no-retail-signal': { trends: false, data: false, description: 'Account has no retail coverage: stores and products exist, but there is no sell-through data.' },
} as const;
export type ScenarioName = keyof typeof SCENARIOS;
export const isScenario = (s: string): s is ScenarioName => Object.hasOwn(SCENARIOS, s);

export const SCENARIO_SKUS = {
  surging: ['VAP-BD-1G', 'PRE-BD-1G'],
  surging_wholesale_ok: 'FLW-OGK-35',
  declining: 'EDB-CHO-MS',
  oos_rising: 'EDB-GUM-WM',
  discontinued: 'FLW-TW-35',
} as const;

const SURGE: Record<string, readonly number[]> = {
  'VAP-BD-1G': [1.3, 1.45, 1.6],
  'PRE-BD-1G': [1.3, 1.45, 1.6],
  'FLW-OGK-35': [1.35, 1.55, 1.75],
};
const ALWAYS_CARRIED = new Set([...Object.keys(SURGE), SCENARIO_SKUS.declining, SCENARIO_SKUS.oos_rising]);

export interface WeekRow {
  week_start: string;
  units: number;
  revenue: number;
  avg_retail_price: number | null;
  days_on_shelf: number;
  oos_days: number;
}

export interface Series {
  sku: string;
  store_id: string;
  /** oldest → newest, length WEEKS */
  weeks: WeekRow[];
}

export interface Dataset {
  scenario: ScenarioName;
  weekStarts: string[];
  /** sku → series per carrying store */
  bySku: Map<string, Series[]>;
}

/** FNV-1a → [0, 1). */
function hash01(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Monday 00:00 UTC of each of the 16 complete weeks before `now`, oldest first. */
export function weekStartsFor(now: Date): string[] {
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  const dow = (new Date(today).getUTCDay() + 6) % 7; // Monday = 0
  const lastWeek = today - dow * DAY_MS - 7 * DAY_MS;
  return Array.from({ length: WEEKS }, (_, w) => new Date(lastWeek - (WEEKS - 1 - w) * 7 * DAY_MS).toISOString().slice(0, 10));
}

function carries(p: CatalogItem, s: Store): boolean {
  return ALWAYS_CARRIED.has(p.sku) || hash01(`carry|${p.sku}|${s.id}`) < 0.8;
}

/** Demand multiplier on in-stock velocity for week w (0 = oldest). */
function trendMultiplier(sku: string, w: number, trends: boolean): number {
  if (!trends) return 1;
  const surge = SURGE[sku];
  if (surge && w >= WEEKS - 3) return surge[w - (WEEKS - 3)]!;
  if (sku === SCENARIO_SKUS.declining && w >= 8) return 1 - 0.06 * (w - 7);
  return 1;
}

function oosDays(sku: string, storeId: string, w: number, trends: boolean): number {
  if (trends && sku === SCENARIO_SKUS.oos_rising) {
    if (w >= WEEKS - 3) return [2, 3, 4][w - (WEEKS - 3)]!;
    if (w >= WEEKS - 6) return 1;
  }
  return hash01(`oos|${sku}|${storeId}|${w}`) < 0.08 ? 1 : 0;
}

export function buildDataset(scenario: ScenarioName, now: Date): Dataset {
  const flags = SCENARIOS[scenario];
  const weekStarts = weekStartsFor(now);
  const bySku = new Map<string, Series[]>();
  for (const p of CATALOG) bySku.set(p.sku, []);
  if (!flags.data) return { scenario, weekStarts, bySku };

  for (const p of CATALOG) {
    const series: Series[] = [];
    for (const s of STORES) {
      if (!carries(p, s)) continue;
      // retail mirrors wholesale volume: the distributor's daily demand spread over its 6 customers
      const baseDaily = (p.demand / 6) * s.size;
      const price = Math.round(p.wholesale * 2 * (0.95 + 0.1 * hash01(`price|${p.sku}|${s.id}`)) * 100) / 100;
      const weeks = weekStarts.map((week_start, w): WeekRow => {
        const discontinued = p.sku === SCENARIO_SKUS.discontinued && w >= 6;
        // off the shelf for good is "not carried", not "out of stock"
        const oos = discontinued ? 0 : oosDays(p.sku, s.id, w, flags.trends);
        const shelf = discontinued ? 0 : 7 - oos;
        const noise = 0.9 + 0.2 * hash01(`units|${p.sku}|${s.id}|${w}`);
        const units = Math.round(baseDaily * trendMultiplier(p.sku, w, flags.trends) * noise * shelf);
        return {
          week_start,
          units,
          revenue: Math.round(units * price * 100) / 100,
          avg_retail_price: units > 0 ? price : null,
          days_on_shelf: shelf,
          oos_days: oos,
        };
      });
      series.push({ sku: p.sku, store_id: s.id, weeks });
    }
    bySku.set(p.sku, series);
  }
  return { scenario, weekStarts, bySku };
}

// ── aggregates ───────────────────────────────────────────────────────────────────────────────

export interface WeekAgg {
  week_start: string;
  units: number;
  revenue: number;
  stores_carrying: number;
  shelf_days: number;
  oos_days: number;
}

export function aggregate(ds: Dataset, sku: string): WeekAgg[] {
  const series = ds.bySku.get(sku) ?? [];
  return ds.weekStarts.map((week_start, w) => {
    let units = 0;
    let revenue = 0;
    let stores = 0;
    let shelf = 0;
    let oos = 0;
    for (const s of series) {
      const row = s.weeks[w]!;
      units += row.units;
      revenue += row.revenue;
      shelf += row.days_on_shelf;
      oos += row.oos_days;
      if (row.days_on_shelf > 0 || row.units > 0) stores++;
    }
    return { week_start, units, revenue: Math.round(revenue * 100) / 100, stores_carrying: stores, shelf_days: shelf, oos_days: series.length ? oos : 0 };
  });
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
export const pct = (now: number, before: number): number | null => (before > 0 ? Math.round((now / before - 1) * 1000) / 10 : null);

export interface TrendMetrics {
  units_last_4w: number;
  units_prior_4w: number;
  /** in-stock velocity (units per store shelf-day), last week vs the week before */
  wow_pct: number | null;
  /** in-stock velocity, last 3 weeks vs the 3 weeks before */
  growth_3w_pct: number | null;
  units_wow_pct: number | null;
  units_growth_3w_pct: number | null;
  stores_carrying: number;
  stores_carrying_4w_ago: number;
  oos_days_last_3w: number;
  oos_days_prior_3w: number;
}

export function trendMetrics(weeks: readonly WeekAgg[]): TrendMetrics {
  const n = weeks.length;
  const slice = (from: number, to: number) => weeks.slice(n - from, n - to);
  const velocity = (ws: readonly WeekAgg[]) => {
    const shelf = sum(ws.map((w) => w.shelf_days));
    return shelf > 0 ? sum(ws.map((w) => w.units)) / shelf : 0;
  };
  const units = (ws: readonly WeekAgg[]) => sum(ws.map((w) => w.units));
  const last1 = slice(1, 0);
  const prev1 = slice(2, 1);
  const last3 = slice(3, 0);
  const prior3 = slice(6, 3);
  return {
    units_last_4w: units(slice(4, 0)),
    units_prior_4w: units(slice(8, 4)),
    wow_pct: pct(velocity(last1), velocity(prev1)),
    growth_3w_pct: pct(velocity(last3), velocity(prior3)),
    units_wow_pct: pct(units(last1), units(prev1)),
    units_growth_3w_pct: pct(units(last3), units(prior3)),
    stores_carrying: weeks[n - 1]?.stores_carrying ?? 0,
    stores_carrying_4w_ago: weeks[n - 5]?.stores_carrying ?? 0,
    oos_days_last_3w: sum(last3.map((w) => w.oos_days)),
    oos_days_prior_3w: sum(prior3.map((w) => w.oos_days)),
  };
}
