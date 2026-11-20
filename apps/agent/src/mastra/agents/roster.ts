import { PrincipalSchema, type BudgetLimits, type Principal, type Scope } from '@ops/harness';

/**
 * The agents: ids, display names, harness scopes, which registry tools each may see, and
 * per-agent budgets. One place, so the scope model (read / propose; never approve) is auditable.
 */
export const AGENTS = {
  opsLead: { id: 'ops-lead', name: 'Ops Lead', scopes: ['read'] },
  inventoryAnalyst: { id: 'inventory-analyst', name: 'Inventory Analyst', scopes: ['read'] },
  procurementPlanner: { id: 'procurement-planner', name: 'Procurement Planner', scopes: ['read', 'propose'] },
  complianceReviewer: { id: 'compliance-reviewer', name: 'Compliance Reviewer', scopes: ['read'] },
  policyCritic: { id: 'policy-critic', name: 'Policy Critic', scopes: ['read'] },
  // Authors vendor-reply proposals (propose scope), but has only read tools: the workflow assembles ops in code.
  vendorLiaison: { id: 'vendor-liaison', name: 'Vendor Liaison', scopes: ['read', 'propose'] },
} as const satisfies Record<string, { id: string; name: string; scopes: readonly Exclude<Scope, 'approve'>[] }>;

export type AgentKey = keyof typeof AGENTS;
export type AgentId = (typeof AGENTS)[AgentKey]['id'];
export const AGENT_KEYS = Object.keys(AGENTS) as AgentKey[];

export function agentKeyOf(id: string): AgentKey | undefined {
  return AGENT_KEYS.find((k) => AGENTS[k].id === id);
}

/** The harness principal an agent acts as. Parsed with the harness schema, which forbids `approve` for agents. */
export function principalFor(key: AgentKey): Principal {
  const a = AGENTS[key];
  return PrincipalSchema.parse({ kind: 'agent', id: a.id, scopes: [...a.scopes], label: a.name });
}

/**
 * Registry names each agent is given (further filtered by its principal's scopes via
 * `registry.catalog(principal)`). Write actions only ever appear as `propose_*` tools.
 */
export const AGENT_TOOLS: Record<AgentKey, readonly string[]> = {
  opsLead: [
    'distru.velocity_report',
    'distru.inventory',
    'distru.products_get',
    'distru.products_search',
    'distru.vendors',
    'distru.vendor_purchase_history',
    'distru.open_orders',
    'distru.compliance_check',
    'headset.retail_trends',
    'headset.top_movers',
    // AR questions ("Which invoices are overdue? Sum by customer.").
    'distru.invoices_overdue',
    'distru.invoices_search',
    // Account context (packages/context): vendor reliability from synced history, and learned / told memories.
    'context.vendor_profile',
    'context.memories_search',
    // Semantic recall over vendor email / PO notes (present only while the `recall` connector is registered).
    'recall.search',
  ],
  inventoryAnalyst: ['distru.velocity_report', 'distru.inventory', 'distru.open_orders', 'distru.products_get', 'headset.retail_trends', 'headset.demand_signal'],
  // `distru_mcp.mutate_product` (per-buyer menu cap) is only present while the MCP bridge is connected.
  procurementPlanner: ['distru.vendors', 'distru.vendor_purchase_history', 'distru.products_get', 'context.context_for', 'recall.search', 'distru.purchases.upsert', 'distru_mcp.mutate_product'],
  complianceReviewer: ['distru.compliance_check', 'distru.products_get'],
  policyCritic: ['distru.vendors', 'distru.products_get'],
  vendorLiaison: ['distru.vendor_purchase_history', 'distru.products_get', 'context.context_for', 'recall.search', 'composio.gmail_fetch_message_by_thread_id', 'composio.gmail_fetch_message_by_message_id'],
};

/** Per-agent budget for one agent call (tool calls = steps). The run budget caps the sum. */
export const AGENT_BUDGETS: Record<AgentKey, BudgetLimits> = {
  opsLead: { maxSteps: 25, maxTokens: 400_000, maxCostUsd: 3, maxWallClockMs: 5 * 60_000 },
  // Wholesale velocity + retail trends + one demand_signal per candidate SKU.
  inventoryAnalyst: { maxSteps: 40, maxTokens: 500_000, maxCostUsd: 3, maxWallClockMs: 6 * 60_000 },
  procurementPlanner: { maxSteps: 20, maxTokens: 300_000, maxCostUsd: 2, maxWallClockMs: 4 * 60_000 },
  complianceReviewer: { maxSteps: 16, maxTokens: 250_000, maxCostUsd: 2, maxWallClockMs: 4 * 60_000 },
  policyCritic: { maxSteps: 6, maxTokens: 120_000, maxCostUsd: 1, maxWallClockMs: 2 * 60_000 },
  vendorLiaison: { maxSteps: 6, maxTokens: 120_000, maxCostUsd: 0.5, maxWallClockMs: 2 * 60_000 },
};

/** Whole restock run (sum over every agent call), checked before each agent call. */
export const RUN_BUDGET = { maxTokens: 2_000_000, maxCostUsd: 15 } as const;

/** Max LLM steps (model calls) per agent call. */
export const AGENT_MAX_STEPS: Record<AgentKey, number> = {
  opsLead: 12,
  inventoryAnalyst: 12,
  procurementPlanner: 12,
  complianceReviewer: 12,
  policyCritic: 4,
  vendorLiaison: 4,
};
