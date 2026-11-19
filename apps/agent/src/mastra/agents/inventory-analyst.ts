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
    avg_daily_demand: z.number(),
    days_of_supply: z.number().nullable(),
    reorder_status: z.string(),
    suggested_qty: z.number().nullable().describe('From velocity_report, unchanged'),
    units_per_case: z.number().nullable(),
    open_order_demand: z.number().describe('Units of this product on open sales orders (0 if none)'),
    urgency_rank: z.number().int().min(1).describe('1 = most urgent'),
    reason: z.string().max(400).describe('One or two sentences: why it is at risk, with the numbers'),
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
stock out before a replenishment order could arrive, and you rank them. You only read data.

## Method
1. Call distru_velocity_report with below_reorder_point=true, the location id you are given in location_ids,
   and lead_time_days set to the vendor lead time. Vendors have different lead times: group the vendors you are
   given by lead time and call the report once per group with vendor_ids and that group's lead_time_days. If no
   vendor lead times are given, call it once without vendor_ids and lead_time_days=14.
2. Call distru_open_orders (product_ids = the candidate SKUs, location_ids = your location) to see committed demand.
3. Optionally call distru_inventory for exact available/reserved stock when the report looks inconsistent.
4. A SKU is at risk when reorder_status is LATE, ORDER_NOW or ORDER_SOON, or when days_of_supply (with incoming)
   is below the vendor lead time, or when open-order demand exceeds available stock. Skip NO_RECENT_SALES rows
   unless open orders exist.
5. Rank by urgency: lowest days of supply first, then open-order demand, then reorder_by_date.

## Output
Return the at-risk SKUs for your location (at most the 10 most urgent) with the exact numbers from the tools (copy suggested_qty
unchanged: the Planner decides quantities). \`reason\` states the numbers that make it urgent, e.g.
"4.2 days of supply vs 14-day lead time; 36 units on open orders". Keep \`summary\` to a few sentences.
If a scope (product ids / vendor ids) is given, only report SKUs inside it.

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
      'Reads inventory velocity, stock and open sales orders for one location and returns ranked at-risk SKUs with days of supply and reasons. Read-only.',
    instructions: INVENTORY_ANALYST_INSTRUCTIONS,
    model,
    tools,
  });
}
