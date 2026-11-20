import type { MastraModelConfig } from '@mastra/core/llm';
import type { Memory } from '@mastra/memory';
import type { Env } from '../../env';
import type { RestockLauncher } from '../restock-launcher';
import { createHarnessTools, type HarnessToolDeps, type HarnessToolSet } from '../tools/harness-tools';
import { createComplianceReviewer } from './compliance-reviewer';
import { createInventoryAnalyst } from './inventory-analyst';
import { createOpsLead, createStartRestockRunTool } from './ops-lead';
import { createPolicyCritic } from './policy-critic';
import { createProcurementPlanner } from './procurement-planner';
import { createVendorLiaison } from './vendor-liaison';
import type { AgentKey } from './roster';

export interface AgentDeps<TCtx> extends HarnessToolDeps<TCtx> {
  models: Record<AgentKey, MastraModelConfig>;
  launcher: RestockLauncher;
  /** Ops Lead memory (defaults to a Memory on the Mastra instance's storage). */
  memory?: Memory;
  /**
   * The `recall` connector is registered: the Ops Lead, Planner and Vendor Liaison get the recall
   * section in their instructions (their `recall_search` tool comes from the registry either way).
   */
  recall?: boolean;
}

/** Per-agent model ids from env (each falls back to OPS_AGENT_MODEL). Strings are Mastra model-router ids. */
export function modelsFromEnv(env: Env): Record<AgentKey, string> {
  const fallback = env.OPS_AGENT_MODEL;
  return {
    opsLead: env.OPS_LEAD_MODEL ?? fallback,
    inventoryAnalyst: env.INVENTORY_ANALYST_MODEL ?? fallback,
    procurementPlanner: env.PROCUREMENT_PLANNER_MODEL ?? fallback,
    complianceReviewer: env.COMPLIANCE_REVIEWER_MODEL ?? fallback,
    policyCritic: env.POLICY_CRITIC_MODEL ?? fallback,
    vendorLiaison: env.VENDOR_LIAISON_MODEL ?? fallback,
  };
}

/**
 * Builds the five agents. Each gets harness-generated tools for its own principal (see
 * `createHarnessTools`); the Ops Lead additionally gets `start_restock_run` and the four
 * specialists as subagents. Register the returned object as `agents` on the Mastra instance.
 */
export function createAgents<TCtx>(deps: AgentDeps<TCtx>) {
  // Resolved per agent call from the *current* registry (memoized per registry instance), so tools
  // contributed by a connector that came up after boot (e.g. distru_mcp) appear without a restart.
  const cache = new Map<AgentKey, { registry: unknown; tools: HarnessToolSet }>();
  const tools = (key: AgentKey) => (): HarnessToolSet => {
    const registry = deps.registry;
    const hit = cache.get(key);
    if (hit && hit.registry === registry) return hit.tools;
    const built = createHarnessTools(deps, key);
    cache.set(key, { registry, tools: built });
    return built;
  };
  const inventoryAnalyst = createInventoryAnalyst({ model: deps.models.inventoryAnalyst, tools: tools('inventoryAnalyst') });
  const recall = deps.recall ?? false;
  const procurementPlanner = createProcurementPlanner({ model: deps.models.procurementPlanner, tools: tools('procurementPlanner'), recall });
  const complianceReviewer = createComplianceReviewer({ model: deps.models.complianceReviewer, tools: tools('complianceReviewer') });
  const policyCritic = createPolicyCritic({ model: deps.models.policyCritic, tools: tools('policyCritic') });
  // Vendor-reply workflow only (not a supervisor subagent): classifies vendor emails.
  const vendorLiaison = createVendorLiaison({ model: deps.models.vendorLiaison, tools: tools('vendorLiaison'), recall });
  const startRestockRun = createStartRestockRunTool(deps.launcher);
  const opsLead = createOpsLead({
    model: deps.models.opsLead,
    tools: () => ({ ...tools('opsLead')(), start_restock_run: startRestockRun }),
    agents: { inventoryAnalyst, procurementPlanner, complianceReviewer, policyCritic },
    ...(deps.memory ? { memory: deps.memory } : {}),
    recall,
  });
  return { opsLead, inventoryAnalyst, procurementPlanner, complianceReviewer, policyCritic, vendorLiaison };
}

export type OpsAgents = ReturnType<typeof createAgents>;
