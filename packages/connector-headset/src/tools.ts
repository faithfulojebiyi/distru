import { defineReadTool } from '@ops/harness';
import { z } from 'zod';
import type { TrendRow } from './client';
import { label, resolveProducts, SkuSelector, type HeadsetCtx } from './shared';
import { blendDemandSignal, classifyOosTrend, classifyRetailSignal, OosTrendSchema, RecommendationSchema, RetailSignalSchema } from './signal';

// ── retail_trends ────────────────────────────────────────────────────────────────────────────

export const RetailTrendRow = z.object({
  sku: z.string(),
  product_name: z.string(),
  units_last_4w: z.number(),
  wow_pct: z.number().nullable().describe('In-stock velocity, last week vs the week before (%)'),
  growth_3w_pct: z.number().nullable().describe('In-stock velocity, last 3 weeks vs the 3 before (%)'),
  stores_carrying: z.number(),
  oos_days_last_3w: z.number().describe('Store-days out of stock, last 3 weeks'),
  oos_days_prior_3w: z.number(),
  oos_trend: OosTrendSchema,
  signal: RetailSignalSchema,
});
export type RetailTrendRow = z.infer<typeof RetailTrendRow>;

export const RetailTrendsOutput = z.object({
  latest_week: z.string().nullable().describe('Monday of the latest complete retail week'),
  rows: z.array(RetailTrendRow),
  unmatched: z.array(z.string()),
});

export function toTrendRow(t: TrendRow, productName = t.product_name): RetailTrendRow {
  return {
    sku: t.sku,
    product_name: label(productName, 80),
    units_last_4w: t.units_last_4w,
    wow_pct: t.wow_pct,
    growth_3w_pct: t.growth_3w_pct,
    stores_carrying: t.stores_carrying,
    oos_days_last_3w: t.oos_days_last_3w,
    oos_days_prior_3w: t.oos_days_prior_3w,
    oos_trend: classifyOosTrend(t),
    signal: classifyRetailSignal(t),
  };
}

export const retailTrendsTool = defineReadTool({
  name: 'retail_trends',
  description:
    'Retail sell-through trend per SKU across dispensaries (Headset): units last 4 weeks, week-over-week and 3-week growth of in-stock velocity, stores carrying, out-of-stock days, and a signal (surging ≥30%, rising ≥10%, flat, declining ≤−10%, no_data). Use to spot demand shifts before they hit wholesale velocity.',
  input: SkuSelector,
  output: RetailTrendsOutput,
  run: async (ctx: HeadsetCtx, input) => {
    const client = ctx.connectors.headset;
    const { products, unmatched } = await resolveProducts(client, input);
    if (!products.length) return { latest_week: null, rows: [], unmatched };
    const { latestWeek, rows } = await client.trends({ skus: products.map((p) => p.sku), weeks: 6 });
    return { latest_week: latestWeek, rows: rows.map((t) => toTrendRow(t)), unmatched };
  },
});

// ── retail_sell_through ──────────────────────────────────────────────────────────────────────

export const SellThroughInput = z
  .object({
    skus: z.array(z.string().min(1).max(64)).max(10).optional(),
    product_names: z.array(z.string().min(1).max(120)).max(10).optional(),
    store_ids: z.array(z.string().min(1).max(64)).max(25).optional().describe('Limit to these Headset store ids'),
    weeks: z.number().int().min(1).max(16).default(6),
    max_stores: z.number().int().min(1).max(25).default(10).describe('Per SKU, top stores by units'),
  })
  .refine((v) => (v.skus?.length ?? 0) + (v.product_names?.length ?? 0) > 0, { message: 'give at least one sku or product name' });

export const SellThroughOutput = z.object({
  week_starts: z.array(z.string()).describe('Monday of each week, oldest → newest; arrays below align to it'),
  rows: z.array(
    z.object({
      sku: z.string(),
      store_id: z.string(),
      store: z.string().describe('Store name (identifier only)'),
      units: z.array(z.number()),
      oos_days: z.array(z.number()),
    }),
  ),
  truncated: z.boolean().describe('True when stores were cut by max_stores'),
  unmatched: z.array(z.string()),
});

export const retailSellThroughTool = defineReadTool({
  name: 'retail_sell_through',
  description: 'Weekly retail units and out-of-stock days per SKU per store (Headset), trimmed to the top stores by volume. Use to check whether a trend is broad (many stores) or one outlier store.',
  input: SellThroughInput,
  output: SellThroughOutput,
  run: async (ctx: HeadsetCtx, input) => {
    const client = ctx.connectors.headset;
    const { products, unmatched } = await resolveProducts(client, input);
    if (!products.length) return { week_starts: [], rows: [], truncated: false, unmatched };
    const { weekStarts, rows } = await client.sellThrough({ skus: products.map((p) => p.sku), ...(input.store_ids ? { storeIds: input.store_ids } : {}), weeks: input.weeks });
    let truncated = false;
    const out = products.flatMap((p) => {
      const mine = rows
        .filter((r) => r.sku === p.sku)
        .map((r) => ({ r, total: r.weeks.reduce((a, w) => a + w.units, 0) }))
        .sort((a, b) => b.total - a.total || a.r.store_id.localeCompare(b.r.store_id));
      if (mine.length > input.max_stores) truncated = true;
      return mine.slice(0, input.max_stores).map(({ r }) => ({
        sku: r.sku,
        store_id: label(r.store_id, 64),
        store: label(r.store_name),
        units: r.weeks.map((w) => w.units),
        oos_days: r.weeks.map((w) => w.oos_days),
      }));
    });
    return { week_starts: weekStarts, rows: out, truncated, unmatched };
  },
});

// ── top_movers ───────────────────────────────────────────────────────────────────────────────

export const TopMoversInput = z.object({
  window: z.enum(['7d', '28d']).default('28d').describe('7d: last week vs the week before; 28d: last 4 weeks vs the 4 before'),
  direction: z.enum(['up', 'down', 'both']).default('both'),
  limit: z.number().int().min(1).max(25).default(10),
});

export const TopMoversOutput = z.object({
  window: z.enum(['7d', '28d']),
  latest_week: z.string().nullable(),
  rows: z.array(
    z.object({
      sku: z.string(),
      product_name: z.string(),
      change_pct: z.number(),
      units: z.number(),
      prior_units: z.number(),
      direction: z.enum(['up', 'down']),
      stores_carrying: z.number(),
      oos_days: z.number().describe('Store-days out of stock in the window: a "down" mover with many is a supply problem, not a demand drop'),
    }),
  ),
});

export const topMoversTool = defineReadTool({
  name: 'top_movers',
  description: 'Products with the biggest retail unit change across dispensaries (Headset) over 7 or 28 days, up and/or down.',
  input: TopMoversInput,
  output: TopMoversOutput,
  run: async (ctx: HeadsetCtx, input) => {
    const { latestWeek, rows } = await ctx.connectors.headset.topMovers(input);
    return {
      window: input.window,
      latest_week: latestWeek,
      rows: rows.map((r) => ({ ...r, product_name: label(r.product_name, 80) })),
    };
  },
});

// ── demand_signal ────────────────────────────────────────────────────────────────────────────

export const DemandSignalInput = z
  .object({
    sku: z.string().min(1).max(64).optional(),
    product_name: z.string().min(1).max(120).optional(),
    wholesale_days_of_supply: z.number().min(0).nullable().describe('From distru_velocity_report days_of_supply (null when no demand)'),
    wholesale_avg_daily: z.number().min(0).describe('From distru_velocity_report avg_daily_demand'),
    lead_time_days: z.number().min(0).max(180).default(14),
    safety_days: z.number().min(0).max(90).default(7),
  })
  .refine((v) => v.sku || v.product_name, { message: 'give sku or product_name' });

export const DemandSignalOutput = z.object({
  sku: z.string().nullable(),
  product_name: z.string().nullable(),
  retail: z.object({
    signal: RetailSignalSchema,
    growth_3w_pct: z.number().nullable(),
    wow_pct: z.number().nullable(),
    oos_trend: OosTrendSchema.nullable(),
    stores_carrying: z.number(),
  }),
  wholesale: z.object({ days_of_supply: z.number().nullable(), avg_daily: z.number() }),
  adjusted_days_of_supply: z.number().nullable(),
  adjusted_avg_daily: z.number(),
  demand_factor: z.number(),
  recommendation: RecommendationSchema,
  reasons: z.array(z.string()),
});

export const demandSignalTool = defineReadTool({
  name: 'demand_signal',
  description:
    'Blend wholesale velocity (pass the Distru days_of_supply + avg_daily_demand) with retail sell-through for one SKU. Fetches retail trends itself and computes adjusted days of supply and a recommendation (reorder_now | watch | ok) with reasons. Do the maths here, not in your head.',
  input: DemandSignalInput,
  output: DemandSignalOutput,
  run: async (ctx: HeadsetCtx, input) => {
    const client = ctx.connectors.headset;
    const { products } = await resolveProducts(client, { skus: input.sku ? [input.sku] : [], product_names: input.product_name ? [input.product_name] : [] });
    const product = products[0];
    const trend = product ? (await client.trends({ skus: [product.sku], weeks: 6 })).rows[0] : undefined;
    const row = trend ? toTrendRow(trend) : null;
    const hasSignal = row !== null && row.signal !== 'no_data';
    const blend = blendDemandSignal({
      wholesaleDaysOfSupply: input.wholesale_days_of_supply,
      wholesaleAvgDaily: input.wholesale_avg_daily,
      retailGrowth3w: hasSignal ? row.growth_3w_pct : null,
      retailOosTrend: hasSignal ? row.oos_trend : null,
      leadTimeDays: input.lead_time_days,
      safetyDays: input.safety_days,
    });
    return {
      sku: product?.sku ?? null,
      product_name: product ? label(product.name, 80) : null,
      retail: {
        signal: row?.signal ?? 'no_data',
        growth_3w_pct: hasSignal ? row.growth_3w_pct : null,
        wow_pct: hasSignal ? row.wow_pct : null,
        oos_trend: hasSignal ? row.oos_trend : null,
        stores_carrying: row?.stores_carrying ?? 0,
      },
      wholesale: { days_of_supply: input.wholesale_days_of_supply, avg_daily: input.wholesale_avg_daily },
      adjusted_days_of_supply: blend.adjustedDaysOfSupply,
      adjusted_avg_daily: blend.adjustedAvgDaily,
      demand_factor: blend.demandFactor,
      recommendation: blend.recommendation,
      reasons: product ? blend.reasons : [`product not found in retail catalog; ${blend.reasons.join('; ')}`],
    };
  },
});
