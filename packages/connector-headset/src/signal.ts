/**
 * Retail signal classification and the wholesale × retail demand blend.
 *
 * Maths in code, not in the prompt: the Inventory Analyst never multiplies growth rates or days of
 * supply itself. It calls `demand_signal`, which runs these pure functions and returns the numbers
 * plus plain-language reasons it can quote.
 */
import { z } from 'zod';

export const RetailSignalSchema = z.enum(['surging', 'rising', 'flat', 'declining', 'no_data']);
export type RetailSignal = z.infer<typeof RetailSignalSchema>;

export const OosTrendSchema = z.enum(['rising', 'flat', 'falling']);
export type OosTrend = z.infer<typeof OosTrendSchema>;

export const RecommendationSchema = z.enum(['reorder_now', 'watch', 'ok']);
export type Recommendation = z.infer<typeof RecommendationSchema>;

/** 3-week growth thresholds (percent, in-stock velocity). */
export const SIGNAL_THRESHOLDS = { surging: 30, rising: 10, declining: -10 } as const;
/** Below this many retail units in 4 weeks a trend is noise. */
export const MIN_UNITS_4W = 8;

export function classifyRetailSignal(t: { has_data: boolean; growth_3w_pct: number | null; units_last_4w: number }): RetailSignal {
  if (!t.has_data || t.growth_3w_pct === null || t.units_last_4w < MIN_UNITS_4W) return 'no_data';
  const g = t.growth_3w_pct;
  if (g >= SIGNAL_THRESHOLDS.surging) return 'surging';
  if (g >= SIGNAL_THRESHOLDS.rising) return 'rising';
  if (g <= SIGNAL_THRESHOLDS.declining) return 'declining';
  return 'flat';
}

/**
 * Store-days out of stock, last 3 weeks vs the 3 before. A change counts when it is at least
 * max(3 days, one extra day per carrying store, 50% of the smaller window), so a couple of random
 * stock-outs across a chain stay `flat`.
 */
export function classifyOosTrend(t: { oos_days_last_3w: number; oos_days_prior_3w: number; stores_carrying: number }): OosTrend {
  const last = t.oos_days_last_3w;
  const prior = t.oos_days_prior_3w;
  const min = Math.max(3, t.stores_carrying, 0.5 * Math.min(last, prior));
  if (last - prior >= min) return 'rising';
  if (prior - last >= min) return 'falling';
  return 'flat';
}

export interface BlendInput {
  /** Distru on-hand ÷ avg daily demand; null when there is no wholesale demand to divide by. */
  wholesaleDaysOfSupply: number | null;
  /** Distru avg daily wholesale demand (units/day). */
  wholesaleAvgDaily: number;
  /** Retail in-stock velocity growth, last 3 weeks vs the 3 before, percent (45 = +45%); null = no retail signal. */
  retailGrowth3w: number | null;
  /** Retail store-days out of stock trend; null = unknown. */
  retailOosTrend: OosTrend | null;
  /** Vendor lead time (days). Default 14. */
  leadTimeDays?: number;
  /** Safety buffer on top of lead time (days). Default 7. */
  safetyDays?: number;
}

export interface BlendResult {
  adjustedDaysOfSupply: number | null;
  adjustedAvgDaily: number;
  /** Multiplier applied to wholesale demand (1 = unchanged). */
  demandFactor: number;
  recommendation: Recommendation;
  reasons: string[];
}

export const BLEND = {
  /** |growth| below this is treated as noise. */
  noisePct: 10,
  /** Growth is capped to [-50%, +150%] before projecting. */
  minGrowthPct: -50,
  maxGrowthPct: 150,
  /** Declines only count half: under-ordering into a stock-out costs more than carrying a week of extra stock. */
  declineWeight: 0.5,
  /** Rising retail stock-outs hide demand (empty shelves sell nothing): +15% on top. */
  oosUplift: 1.15,
} as const;

const round1 = (n: number) => Math.round(n * 10) / 10;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const signed = (n: number) => `${n >= 0 ? '+' : ''}${round1(n)}%`;

/**
 * Blend wholesale velocity (Distru) with retail sell-through (Headset) into one recommendation.
 *
 *   effective growth g = retailGrowth3w clamped to [-50, 150]; 0 if |g| < 10 (noise) or unknown;
 *                        declines weighted ×0.5
 *   demandFactor       = (1 + g/100) × (1.15 if retail stock-outs are rising)
 *   adjustedAvgDaily   = wholesaleAvgDaily × demandFactor
 *   adjustedDoS        = wholesaleDaysOfSupply ÷ demandFactor        (same stock, faster burn)
 *   cover              = leadTimeDays + safetyDays
 *
 *   reorder_now  wholesale DoS ≤ lead time (a PO placed today barely lands in time), or adjustedDoS ≤ cover
 *   watch        adjustedDoS ≤ 2 × cover, or retail surging (g ≥ 30), or stock-outs rising:
 *                retail moves lead wholesale orders by weeks, so a surge is flagged even when stock looks deep
 *   ok           otherwise
 */
export function blendDemandSignal(input: BlendInput): BlendResult {
  const lead = input.leadTimeDays ?? 14;
  const cover = lead + (input.safetyDays ?? 7);
  const reasons: string[] = [];
  const rawGrowth = input.retailGrowth3w;

  let effective = 0;
  if (rawGrowth === null || !Number.isFinite(rawGrowth)) {
    reasons.push('no retail signal: wholesale velocity only');
  } else if (Math.abs(rawGrowth) < BLEND.noisePct) {
    reasons.push(`retail flat (${signed(rawGrowth)} over 3 weeks)`);
  } else {
    const clamped = Math.min(BLEND.maxGrowthPct, Math.max(BLEND.minGrowthPct, rawGrowth));
    effective = clamped < 0 ? clamped * BLEND.declineWeight : clamped;
    reasons.push(
      clamped < 0
        ? `retail declining ${signed(rawGrowth)} over 3 weeks: wholesale demand trimmed ${signed(effective)} (declines count half)`
        : `retail ${clamped >= 30 ? 'surging' : 'rising'} ${signed(rawGrowth)} over 3 weeks: wholesale demand projected ${signed(clamped)}`,
    );
  }

  let factor = 1 + effective / 100;
  const oosRising = input.retailOosTrend === 'rising';
  if (oosRising) {
    factor *= BLEND.oosUplift;
    reasons.push('retail stock-outs rising: shelves are empty, true demand is higher than sales show (+15%)');
  }
  factor = round3(factor);
  const avg = Math.max(0, input.wholesaleAvgDaily);
  const adjustedAvgDaily = round3(avg * factor);
  const surging = rawGrowth !== null && rawGrowth >= SIGNAL_THRESHOLDS.surging;

  const dos = input.wholesaleDaysOfSupply;
  if (dos === null || !Number.isFinite(dos) || avg <= 0) {
    const flagged = surging || oosRising;
    reasons.push(flagged ? 'no wholesale velocity to project from, but retail is moving: check stock' : 'no wholesale demand');
    return { adjustedDaysOfSupply: null, adjustedAvgDaily, demandFactor: factor, recommendation: flagged ? 'watch' : 'ok', reasons };
  }

  const adjusted = round1(Math.max(0, dos) / factor);
  let recommendation: Recommendation;
  if (dos <= lead) {
    recommendation = 'reorder_now';
    reasons.push(`wholesale days of supply ${round1(dos)} ≤ lead time ${lead}: reorder regardless of retail`);
  } else if (adjusted <= cover) {
    recommendation = 'reorder_now';
    reasons.push(`adjusted days of supply ${adjusted} ≤ lead time + safety ${cover}`);
  } else if (adjusted <= 2 * cover || surging || oosRising) {
    recommendation = 'watch';
    reasons.push(
      adjusted <= 2 * cover
        ? `adjusted days of supply ${adjusted} within 2× cover (${2 * cover})`
        : `adjusted days of supply ${adjusted} still deep, but retail demand leads wholesale orders: watch`,
    );
  } else {
    recommendation = 'ok';
    reasons.push(`adjusted days of supply ${adjusted} > 2× cover (${2 * cover})`);
  }
  return { adjustedDaysOfSupply: adjusted, adjustedAvgDaily, demandFactor: factor, recommendation, reasons };
}
