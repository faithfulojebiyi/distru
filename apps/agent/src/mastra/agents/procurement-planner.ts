import { Agent } from '@mastra/core/agent';
import type { ToolsInput } from '@mastra/core/agent';
import { z } from 'zod';
import type { AtRiskSku } from './inventory-analyst';
import { AGENTS } from './roster';
import { SuspiciousTextFlagSchema, UNTRUSTED_DATA_RULES, type AgentFactoryOptions } from './shared';

export const PlannedLineSchema = z
  .object({
    product_id: z.string(),
    sku: z.string().nullable(),
    location_id: z.string(),
    decision: z.enum(['ordered', 'skipped']),
    quantity: z.number().nonnegative().describe('Units proposed (0 when skipped)'),
    unit_price: z.number().nonnegative().nullable(),
    reason: z.string().max(400).describe('How the quantity and price were chosen, or why the SKU was skipped'),
  })
  .meta({ id: 'PlannedLine' });

/**
 * Allocation guard suggestion, computed in CODE by the workflow (never by a model): the SKU will stock
 * out before this vendor's PO can arrive (adjusted days of supply < lead time), so remaining stock is
 * shared with a per-buyer cap on each Distru Commerce menu order (`maxMenuBuyerOrderQuantity`).
 */
export const GuardSuggestionSchema = z
  .object({
    product_id: z.string(),
    sku: z.string(),
    name: z.string(),
    cap: z.number().int().positive().describe('Units per buyer per menu order (whole cases, at least one case)'),
    current_cap: z.number().int().nullable().describe('maxMenuBuyerOrderQuantity today (null = no cap)'),
    available: z.number().describe('Company-wide available units'),
    active_buyers: z.number().int().describe('Distinct customers that ordered it in the last 14 days'),
    units_per_case: z.number().nullable(),
    adjusted_days_of_supply: z.number(),
    lead_time_days: z.number(),
    reason: z.string(),
  })
  .meta({ id: 'GuardSuggestion' });
export type GuardSuggestion = z.infer<typeof GuardSuggestionSchema>;

export const PlannerResultSchema = z
  .object({
    vendor_id: z.string(),
    summary: z.string().max(1200).describe('What was proposed for this vendor and why (shown to the approver)'),
    lines: z.array(PlannedLineSchema),
    suspicious_text: z.array(SuspiciousTextFlagSchema),
  })
  .meta({ id: 'PlannerResult' });
export type PlannerResult = z.infer<typeof PlannerResultSchema>;

export const PROCUREMENT_PLANNER_INSTRUCTIONS = `
You are the Procurement Planner for a cannabis distributor running on Distru ERP. For ONE vendor you turn
at-risk SKUs into draft purchase orders (and, when asked, per-buyer menu caps). You are the only agent that can
propose writes, and you can only *propose*: propose_distru_purchases_upsert adds a PO to the run's draft
proposal. (The vendor email and the receiving task for each PO are added by the workflow, not by you.) Nothing is written until the
deterministic policy engine allows it and a human approves it. You cannot approve.

## Method
1. Call distru_vendors with vendor_ids=[the vendor] to confirm the vendor and its lead time.
2. Call distru_vendor_purchase_history (vendor_id, product_ids = the SKUs) for recent unit prices.
3. For each SKU decide a quantity:
   - Start from suggested_qty when present. Otherwise: avg_daily_demand × (lead_time_days + 14) + open_order_demand − on_hand_available − incoming.
   - Round up to whole cases when units_per_case is known. Never order a negative or zero quantity: skip instead.
   - Never exceed 3 × suggested_qty (or 60 days of demand when there is no suggestion) without a numeric reason.
4. unit_price = the last unit price paid to this vendor for that product (price_summary.last_unit_price).
   If there is no history for a product, skip it and say so (do not guess a price).
5. Create ONE purchase order per receiving location: call propose_distru_purchases_upsert with vendor_id,
   location_id, the complete line set for that location, and a short human-readable note. If the tool returns
   ok=false, fix the input and call it again. Calling it again for the same vendor and location replaces your
   earlier draft (use that to revise).
6. Return every SKU you were given in \`lines\` with decision ordered or skipped and the reason.

## Retail-adjusted demand
SKUs carry adjusted_avg_daily_demand / adjusted_days_of_supply from the retail blend (Headset). When there is
no suggested_qty, size the order with adjusted_avg_daily_demand instead of avg_daily_demand when it is present
and larger. A SKU with recommendation "watch" whose formula quantity is zero or negative is skipped (say
"covered: watch only").

## Allocation guard (per-buyer menu cap)
When the task lists ALLOCATION GUARD suggestions (computed by the workflow in code: the SKU will run out before
your PO can arrive), propose each one with propose_distru_mcp_mutate_product:
{ "action": "UPDATE", "id": <product_id>, "maxMenuBuyerOrderQuantity": <cap> } — exactly the suggested cap,
no other fields. It limits how many units one buyer may put in a single Distru Commerce menu order (sales reps
are exempt), so the remaining stock is shared until the PO arrives. Only propose caps for SKUs you order. If
the tool is not available, skip it and say so in your summary.

## Revisions
When you receive policy feedback (from the deterministic policy engine via the Policy Critic), follow the
revision instructions exactly: e.g. reduce quantities to fit a total cap, drop vetoed lines, or split
nothing you were not asked to. Re-propose each affected location (it replaces the earlier draft) and explain
the change in \`summary\`. Never try to get around a rule; never re-add a line the Compliance Reviewer vetoed.
When the instructions contain a HARD BUDGET, the sum of quantity × unit_price over ALL your POs for this vendor
(every location) must be at or below it: compute it before proposing, re-propose every location whose draft
changes, and never leave the total above the budget.

${UNTRUSTED_DATA_RULES}`.trim();

export interface PlannerTask {
  vendor: { id: string; name: string; lead_time_days: number | null };
  items: AtRiskSku[];
  guard?: GuardSuggestion[] | undefined;
  scenarioNote?: string | undefined;
}

function guardLine(guard: readonly GuardSuggestion[] | undefined): string | null {
  if (!guard?.length) return null;
  return `ALLOCATION GUARD suggestions (computed in code; propose each with propose_distru_mcp_mutate_product, exact cap): ${JSON.stringify(
    guard.map((g) => ({ product_id: g.product_id, sku: g.sku, cap: g.cap, current_cap: g.current_cap, reason: g.reason })),
  )}`;
}

export function plannerPrompt(task: PlannerTask): string {
  return [
    `Plan purchase orders for vendor "${task.vendor.name}" (vendor_id ${task.vendor.id}, lead time ${task.vendor.lead_time_days ?? 'unknown'} days).`,
    `At-risk SKUs (from the Inventory Analysts): ${JSON.stringify(task.items)}`,
    guardLine(task.guard),
    task.scenarioNote ? `Operator note (from the person who started the run): ${task.scenarioNote}` : null,
    `Propose one PO per receiving location with propose_distru_purchases_upsert${task.guard?.length ? ', then each allocation-guard cap' : ''}, then return your result.`,
  ]
    .filter(Boolean)
    .join('\n');
}

export interface RevisionTask extends PlannerTask {
  previous: Array<{ summary: string | null; value: number | null; input: unknown }>;
  instruction: string;
  policyReasons: string[];
  vetoedProductIds: string[];
}

export function plannerRevisionPrompt(task: RevisionTask): string {
  return [
    `REVISION for vendor "${task.vendor.name}" (vendor_id ${task.vendor.id}).`,
    `Your current draft POs: ${JSON.stringify(task.previous)}`,
    `Policy findings (deterministic engine): ${JSON.stringify(task.policyReasons)}`,
    `Revision instructions from the Policy Critic: ${task.instruction}`,
    task.vetoedProductIds.length ? `Vetoed by compliance (never re-add): ${JSON.stringify(task.vetoedProductIds)}` : null,
    `At-risk SKUs for context: ${JSON.stringify(task.items)}`,
    guardLine(task.guard),
    'Re-propose every affected location with propose_distru_purchases_upsert (it replaces the earlier draft), then return your result.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function createProcurementPlanner<TTools extends ToolsInput>({ model, tools }: AgentFactoryOptions<TTools>) {
  return new Agent({
    id: AGENTS.procurementPlanner.id,
    name: AGENTS.procurementPlanner.name,
    description:
      'Picks quantities and unit prices for one vendor from purchase history and proposes draft purchase orders (propose only; never writes, never approves). Follows policy revision instructions.',
    instructions: PROCUREMENT_PLANNER_INSTRUCTIONS,
    model,
    tools,
  });
}
