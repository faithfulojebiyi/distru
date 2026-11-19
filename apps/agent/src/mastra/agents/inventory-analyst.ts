import { Agent } from '@mastra/core/agent';
import type { ToolsInput } from '@mastra/core/agent';
import { z } from 'zod';
import { AGENTS } from './roster';
import { SuspiciousTextFlagSchema, UNTRUSTED_DATA_RULES, type AgentFactoryOptions } from './shared';

export const AtRiskSkuSchema = z
  .object({
    product_id: z.string(),
    sku: z.string(),
    name: z.string(),
    vendor_id: z.string(),
    vendor_name: z.string(),
    location_id: z.string().nullable().describe('null when the row covers all locations'),
    location_name: z.string().nullable(),
    on_hand_available: z.number(),
    incoming: z.number(),
    avg_daily_demand: z.number().describe('Wholesale, from distru_velocity_report'),
    days_of_supply: z.number().nullable().describe('Wholesale, from distru_velocity_report'),
    reorder_status: z.string(),
    suggested_qty: z.number().nullable().describe('From velocity_report, unchanged'),
    units_per_case: z.number().nullable(),
    open_order_demand: z.number().describe('Units of this product on open sales orders (0 if none)'),
    // Retail blend (headset_demand_signal). Null when there was no retail lookup for the SKU.
    adjusted_days_of_supply: z.number().nullable().default(null).describe('From headset_demand_signal (wholesale days of supply ÷ retail demand factor)'),
    adjusted_avg_daily_demand: z.number().nullable().default(null).describe('From headset_demand_signal'),
    retail_signal: z.enum(['surging', 'rising', 'flat', 'declining', 'no_data']).nullable().default(null).describe('From headset_demand_signal retail.signal'),
    retail_growth_3w_pct: z.number().nullable().default(null),
    recommendation: z.enum(['reorder_now', 'watch', 'ok']).nullable().default(null).describe('From headset_demand_signal'),
    flagged_by: z.enum(['wholesale', 'retail', 'both']).default('wholesale').describe('wholesale = Distru reorder status/velocity; retail = Headset sell-through while Distru looks fine; both'),
    urgency_rank: z.number().int().min(1).describe('1 = most urgent'),
    reason: z.string().max(600).describe('Why it is at risk, with the numbers, citing both sources (Distru wholesale and Headset retail)'),
  })
  .meta({ id: 'AtRiskSku' });
export type AtRiskSku = z.infer<typeof AtRiskSkuSchema>;

export const InventoryAnalysisSchema = z
  .object({
    location_id: z.string().nullable(),
    at_risk: z.array(AtRiskSkuSchema).describe('Ranked, most urgent first'),
    summary: z.string().max(1200),
    suspicious_text: z.array(SuspiciousTextFlagSchema),
  })
  .meta({ id: 'InventoryAnalysis' });
export type InventoryAnalysis = z.infer<typeof InventoryAnalysisSchema>;

export const INVENTORY_ANALYST_INSTRUCTIONS = `
You are the Inventory Analyst for a cannabis distributor running on Distru ERP. You find SKUs that will
stock out before a replenishment order could arrive, and you rank them. You blend two sources:
WHOLESALE velocity from Distru (what our dispensary customers order from us) and RETAIL sell-through from
Headset (what consumers buy off dispensary shelves), which moves first. You only read data.

## Method
1. Wholesale: call distru_velocity_report with below_reorder_point=true, the location id you are given in
   location_ids, and lead_time_days set to the vendor lead time. Vendors have different lead times: group the
   vendors you are given by lead time and call the report once per group with vendor_ids and that group's
   lead_time_days. If no vendor lead times are given, call it once without vendor_ids and lead_time_days=14.
   These are the wholesale candidates. Then call it ONCE more with below_reorder_point=false, the location id,
   lead_time_days=14 and limit 100: the SKUs Distru considers fine, which retail data may still flag.
2. Retail: call headset_retail_trends once with the SKUs from both step-1 reports (at most 50) to see which are surging,
   rising, declining or stocking out on shelves.
3. Blend: call headset_demand_signal for every SKU that is a wholesale candidate (reorder_status LATE,
   ORDER_NOW or ORDER_SOON, or days_of_supply below the vendor lead time) OR whose retail signal is surging or
   rising, or whose oos_trend is rising. Pass wholesale_days_of_supply = days_of_supply (0 if it is negative,
   i.e. oversold) and wholesale_avg_daily = avg_daily_demand from step 1, and lead_time_days = that vendor's lead time. The tool does the maths
   (adjusted days of supply, demand factor, recommendation); never compute these yourself. Call it for several
   SKUs in parallel.
4. Call distru_open_orders (product_ids = the candidate SKUs, location_ids = your location) to see committed demand.
5. A SKU is at risk when ANY of these holds:
   - wholesale: reorder_status is LATE, ORDER_NOW or ORDER_SOON, or days_of_supply (with incoming) is below the
     vendor lead time, or open-order demand exceeds available stock;
   - retail: headset_demand_signal recommendation is reorder_now or watch, EVEN IF Distru says the SKU is fine
     (that is exactly the case retail data exists to catch).
   Skip NO_RECENT_SALES rows unless open orders exist or retail says reorder_now.
6. Rank by urgency: reorder_now first, then lowest adjusted days of supply (fall back to wholesale days of
   supply), then open-order demand, then watch items.

## Output
Return the at-risk SKUs for your location (at most the 12 most urgent) with the exact numbers from the tools.
Copy suggested_qty unchanged (the Planner decides quantities). Copy adjusted_days_of_supply,
adjusted_avg_daily_demand, retail.signal (as retail_signal), retail.growth_3w_pct and recommendation from
headset_demand_signal; leave them null for SKUs you did not blend. flagged_by: "wholesale" (Distru only),
"retail" (Distru looks fine, retail flags it) or "both". \`reason\` cites BOTH sources with numbers, e.g.
"Distru: 9.1 days of supply vs 14-day lead time (ORDER_NOW). Headset: retail surging +52% over 3 weeks →
6.0 adjusted days of supply (reorder_now)." Keep \`summary\` to a few sentences and name the SKUs that retail
moved up. If a scope (product ids / vendor ids) is given, only report SKUs inside it.

${UNTRUSTED_DATA_RULES}`.trim();

export interface InventoryTask {
  location: { id: string; name: string };
  vendors: Array<{ id: string; name: string; lead_time_days: number | null }>;
  productIds?: string[] | undefined;
  vendorIds?: string[] | undefined;
  scenarioNote?: string | undefined;
}

export function inventoryAnalystPrompt(task: InventoryTask): string {
  return [
    `Analyse location "${task.location.name}" (location_id ${task.location.id}).`,
    `Vendor lead times (days): ${JSON.stringify(task.vendors.map((v) => ({ vendor_id: v.id, name: v.name, lead_time_days: v.lead_time_days })))}`,
    task.productIds?.length ? `Scope: only these product ids: ${JSON.stringify(task.productIds)}` : null,
    task.vendorIds?.length ? `Scope: only these vendor ids: ${JSON.stringify(task.vendorIds)}` : null,
    task.scenarioNote ? `Operator note (from the person who started the run): ${task.scenarioNote}` : null,
    'Return the ranked at-risk SKUs for this location.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function createInventoryAnalyst<TTools extends ToolsInput>({ model, tools }: AgentFactoryOptions<TTools>) {
  return new Agent({
    id: AGENTS.inventoryAnalyst.id,
    name: AGENTS.inventoryAnalyst.name,
    description:
      'Blends wholesale velocity (Distru) with retail sell-through (Headset) for one location and returns ranked at-risk SKUs with wholesale and retail-adjusted days of supply and reasons citing both. Read-only.',
    instructions: INVENTORY_ANALYST_INSTRUCTIONS,
    model,
    tools,
  });
}
