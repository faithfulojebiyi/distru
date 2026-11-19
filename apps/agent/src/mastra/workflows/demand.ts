/**
 * Deterministic demand scan for the restock workflow (code, no model):
 *
 * - **Wholesale candidates** per location: Distru velocity rows (per vendor lead-time group) whose
 *   reorder status is LATE / ORDER_NOW / ORDER_SOON, or whose days of supply (with incoming) are below
 *   the vendor lead time.
 * - **Retail movers**: Headset SKUs that are surging or rising at retail, or whose store stock-outs are
 *   rising (`top_movers` + `retail_trends`). For every mover stocked at a run location, and for every
 *   wholesale candidate, `headset.demand_signal` is computed IN CODE with that location's wholesale
 *   velocity and the vendor's lead time; recommendation `reorder_now` / `watch` flags it at retail.
 *
 * Used twice: as the **pre-check** before any agent call (nothing flagged anywhere in scope → the run
 * ends `nothing_to_order` with zero LLM calls), and in the **merge** step, where code-flagged SKUs the
 * Analyst missed are added and `flagged_by` is computed from these numbers (never taken from the model).
 */
import { VelocityRowSchema, type VelocityRow } from '@ops/connector-distru';
import type { Registry } from '@ops/harness';
import { z } from 'zod';
import type { AppCtx } from '../../harness/registry';
import type { AtRiskSku } from '../agents/inventory-analyst';
import { principalFor } from '../agents/roster';

const analyst = principalFor('inventoryAnalyst');

export const WHOLESALE_STATUSES = ['LATE', 'ORDER_NOW', 'ORDER_SOON'] as const;
/** Velocity rows per location and lead-time group (the mock catalog fits; Distru sorts by days of supply). */
const ROW_LIMIT = 200;

export const DemandSignalSchema = z.object({
  recommendation: z.enum(['reorder_now', 'watch', 'ok']),
  adjusted_days_of_supply: z.number().nullable(),
  adjusted_avg_daily: z.number(),
  demand_factor: z.number(),
  retail: z.object({ signal: z.enum(['surging', 'rising', 'flat', 'declining', 'no_data']), growth_3w_pct: z.number().nullable(), oos_trend: z.enum(['rising', 'flat', 'falling']).nullable() }),
  reasons: z.array(z.string()),
});
export type DemandSignal = z.infer<typeof DemandSignalSchema>;

export const RetailMoverSchema = z.object({ sku: z.string(), signal: z.string(), growth_3w_pct: z.number().nullable(), oos_trend: z.string() });
export type RetailMover = z.infer<typeof RetailMoverSchema>;

export const DemandCandidateSchema = z.object({
  location: z.object({ id: z.string(), name: z.string() }),
  row: VelocityRowSchema,
  lead_time_days: z.number(),
  wholesale: z.boolean(),
  retail: z.boolean(),
  mover: z.boolean(),
  signal: DemandSignalSchema.nullable(),
});
export type DemandCandidate = z.infer<typeof DemandCandidateSchema>;

const VelocityOut = z.object({ rows: z.array(VelocityRowSchema) });
const MoversOut = z.object({ rows: z.array(z.object({ sku: z.string() })) });
const TrendsOut = z.object({ rows: z.array(z.object({ sku: z.string(), signal: z.string(), growth_3w_pct: z.number().nullable(), oos_trend: z.string() })) });

const hasReadTool = (registry: Registry<AppCtx>, name: string) => registry.readTools().some((t) => t.name === name);

export function wholesaleAtRisk(row: VelocityRow, leadTimeDays: number): boolean {
  if ((WHOLESALE_STATUSES as readonly string[]).includes(row.reorder_status)) return true;
  const dos = row.days_of_supply_with_incoming ?? row.days_of_supply;
  return row.avg_daily_demand > 0 && dos !== null && dos < leadTimeDays;
}

export const retailFlagged = (s: DemandSignal | null): boolean => s !== null && (s.recommendation === 'reorder_now' || s.recommendation === 'watch');

/** Retail movers: surging / rising at retail, or store stock-outs rising. Empty when Headset is not registered or down. */
export async function retailMovers(registry: Registry<AppCtx>, ctx: AppCtx): Promise<RetailMover[]> {
  if (!hasReadTool(registry, 'headset.top_movers') || !hasReadTool(registry, 'headset.retail_trends')) return [];
  try {
    const top = MoversOut.parse(await registry.runReadTool(ctx, analyst, 'headset.top_movers', { window: '28d', direction: 'both', limit: 25 }));
    const skus = [...new Set(top.rows.map((r) => r.sku))].slice(0, 50);
    if (!skus.length) return [];
    const trends = TrendsOut.parse(await registry.runReadTool(ctx, analyst, 'headset.retail_trends', { skus }));
    return trends.rows.filter((t) => t.signal === 'surging' || t.signal === 'rising' || t.oos_trend === 'rising');
  } catch {
    return []; // retail down: wholesale only
  }
}

export async function demandSignalFor(registry: Registry<AppCtx>, ctx: AppCtx, row: Pick<VelocityRow, 'sku' | 'days_of_supply' | 'avg_daily_demand'>, leadTimeDays: number): Promise<DemandSignal | null> {
  if (!hasReadTool(registry, 'headset.demand_signal')) return null;
  try {
    return DemandSignalSchema.parse(
      await registry.runReadTool(ctx, analyst, 'headset.demand_signal', {
        sku: row.sku,
        // Oversold rows report negative days of supply; the blend takes 0 (already out).
        wholesale_days_of_supply: row.days_of_supply === null ? null : Math.max(0, row.days_of_supply),
        wholesale_avg_daily: row.avg_daily_demand,
        lead_time_days: leadTimeDays,
      }),
    );
  } catch {
    return null;
  }
}

export interface ScanArgs {
  registry: Registry<AppCtx>;
  ctx: AppCtx;
  locations: ReadonlyArray<{ id: string; name: string }>;
  vendors: ReadonlyArray<{ id: string; lead_time_days: number | null }>;
  scope: { productIds?: readonly string[] | undefined; vendorIds?: readonly string[] | undefined };
}

export interface DemandScan {
  movers: RetailMover[];
  /** Candidates per location id (wholesale and/or retail flagged). */
  byLocation: Record<string, DemandCandidate[]>;
  /** Tool calls made (for the run timeline). */
  calls: number;
}

/** The deterministic scan over every run location (see the module comment). */
export async function scanDemand(a: ScanArgs): Promise<DemandScan> {
  let calls = 0;
  const movers = await retailMovers(a.registry, a.ctx);
  calls += 2;
  const moverSkus = new Set(movers.map((m) => m.sku.toUpperCase()));
  const leadOf = new Map(a.vendors.map((v) => [v.id, v.lead_time_days ?? 14]));
  // One velocity call per lead-time group (the reorder status depends on the lead time).
  const groups = new Map<number, string[]>();
  for (const v of a.vendors) {
    if (a.scope.vendorIds?.length && !a.scope.vendorIds.includes(v.id)) continue;
    const lead = v.lead_time_days ?? 14;
    groups.set(lead, [...(groups.get(lead) ?? []), v.id]);
  }
  if (!groups.size) groups.set(14, []);

  const byLocation: Record<string, DemandCandidate[]> = {};
  for (const location of a.locations) {
    const rows: VelocityRow[] = [];
    // Wholesale candidates only need the rows at/below the reorder point; retail movers may sit above it,
    // so with movers every row is fetched (`'any'`). `below_reorder_point` is a filter both ways.
    for (const below of [moverSkus.size ? ('any' as const) : true]) {
      for (const [lead, vendorIds] of groups) {
        const out = VelocityOut.parse(
          await a.registry.runReadTool(a.ctx, analyst, 'distru.velocity_report', {
            below_reorder_point: below,
            location_ids: [location.id],
            lead_time_days: lead,
            limit: ROW_LIMIT,
            ...(vendorIds.length ? { vendor_ids: vendorIds } : {}),
            ...(a.scope.productIds?.length ? { product_ids: [...a.scope.productIds] } : {}),
          }),
        );
        calls++;
        rows.push(...out.rows);
      }
    }
    const out: DemandCandidate[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.product_id)) continue;
      seen.add(row.product_id);
      if (a.scope.productIds?.length && !a.scope.productIds.includes(row.product_id)) continue;
      if (a.scope.vendorIds?.length && !a.scope.vendorIds.includes(row.vendor.id)) continue;
      const lead = leadOf.get(row.vendor.id) ?? 14;
      const wholesale = wholesaleAtRisk(row, lead);
      const mover = moverSkus.has(row.sku.toUpperCase());
      if (!wholesale && !mover) continue;
      const signal = await demandSignalFor(a.registry, a.ctx, row, lead);
      calls++;
      const retail = retailFlagged(signal);
      if (!wholesale && !retail) continue;
      // No recent sales: only a retail reorder_now keeps it in.
      if (row.reorder_status === 'NO_RECENT_SALES' && signal?.recommendation !== 'reorder_now') continue;
      out.push({ location, row, lead_time_days: lead, wholesale, retail, mover, signal });
    }
    byLocation[location.id] = out;
  }
  return { movers, byLocation, calls };
}

/** flagged_by from the numbers (wholesale velocity vs the retail blend), never from model output. */
export function flaggedBy(c: Pick<DemandCandidate, 'wholesale' | 'retail'>): AtRiskSku['flagged_by'] {
  if (c.wholesale && c.retail) return 'both';
  return c.retail ? 'retail' : 'wholesale';
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** An at-risk SKU built in code for a candidate the Analyst did not report. */
export function atRiskFromCandidate(c: DemandCandidate, vendorName: string, urgencyRank: number): AtRiskSku {
  const r = c.row;
  const s = c.signal;
  const wholesale = c.wholesale
    ? `Distru: ${r.days_of_supply === null ? 'no' : round1(r.days_of_supply)} days of supply vs ${c.lead_time_days}-day lead time (${r.reorder_status}).`
    : `Distru: ${r.days_of_supply === null ? 'no' : round1(r.days_of_supply)} days of supply (${r.reorder_status}).`;
  const retail = s
    ? `Headset: retail ${s.retail.signal}${s.retail.growth_3w_pct !== null ? ` ${s.retail.growth_3w_pct > 0 ? '+' : ''}${round1(s.retail.growth_3w_pct)}% over 3 weeks` : ''}${s.retail.oos_trend === 'rising' ? ', stock-outs rising' : ''} → ${s.adjusted_days_of_supply ?? 'n/a'} adjusted days of supply (${s.recommendation}).`
    : 'Headset: no retail signal.';
  return {
    product_id: r.product_id,
    sku: r.sku,
    name: r.name,
    vendor_id: r.vendor.id,
    vendor_name: vendorName,
    location_id: c.location.id,
    location_name: c.location.name,
    on_hand_available: r.on_hand_available,
    incoming: r.incoming,
    avg_daily_demand: r.avg_daily_demand,
    days_of_supply: r.days_of_supply,
    reorder_status: r.reorder_status,
    suggested_qty: r.suggested_qty,
    units_per_case: r.units_per_case,
    open_order_demand: 0,
    adjusted_days_of_supply: s?.adjusted_days_of_supply ?? null,
    adjusted_avg_daily_demand: s?.adjusted_avg_daily ?? null,
    retail_signal: s?.retail.signal ?? null,
    retail_growth_3w_pct: s?.retail.growth_3w_pct ?? null,
    recommendation: s?.recommendation ?? null,
    flagged_by: flaggedBy(c),
    urgency_rank: urgencyRank,
    reason: `${wholesale} ${retail} (flagged in code; the Analyst did not list it)`.slice(0, 600),
  };
}

/**
 * Merge one location's Analyst output with the code scan: every code candidate is present (added when
 * missing), `flagged_by` and missing retail numbers come from code. Analyst SKUs the scan did not flag
 * keep their reason (e.g. open-order demand) and `flagged_by: wholesale`.
 */
export function mergeWithScan(analysed: readonly AtRiskSku[], candidates: readonly DemandCandidate[], vendorName: (id: string, fallback: string) => string): AtRiskSku[] {
  const byProduct = new Map(candidates.map((c) => [c.row.product_id, c]));
  const out: AtRiskSku[] = analysed.map((a) => {
    const c = byProduct.get(a.product_id);
    if (!c) return { ...a, flagged_by: 'wholesale' as const };
    const s = c.signal;
    return {
      ...a,
      flagged_by: flaggedBy(c),
      adjusted_days_of_supply: a.adjusted_days_of_supply ?? s?.adjusted_days_of_supply ?? null,
      adjusted_avg_daily_demand: a.adjusted_avg_daily_demand ?? s?.adjusted_avg_daily ?? null,
      retail_signal: a.retail_signal ?? s?.retail.signal ?? null,
      retail_growth_3w_pct: a.retail_growth_3w_pct ?? s?.retail.growth_3w_pct ?? null,
      recommendation: s?.recommendation ?? a.recommendation,
    };
  });
  const present = new Set(analysed.map((a) => a.product_id));
  let rank = Math.max(0, ...analysed.map((a) => a.urgency_rank)) + 1;
  const missing = candidates.filter((c) => !present.has(c.row.product_id)).sort((x, y) => (x.signal?.recommendation === 'reorder_now' ? 0 : 1) - (y.signal?.recommendation === 'reorder_now' ? 0 : 1));
  for (const c of missing) out.push(atRiskFromCandidate(c, vendorName(c.row.vendor.id, c.row.vendor.name), rank++));
  return out;
}
