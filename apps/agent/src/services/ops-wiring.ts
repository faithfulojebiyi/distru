/**
 * Process wiring for the MCP server, MCP tokens, undo, policy rules and locations (kept out of
 * app.ts so the composition root only adds a few lines).
 */
import { userPrincipal } from '@ops/harness';
import { createMcpHttpRoutes } from '../api/mcp-http';
import type { ApiServices } from '../api/services';
import { db } from '../db/client';
import { env } from '../env';
import { appAuditSink, appHarness } from '../harness/app';
import { APP_POLICY_RULES } from '../harness/policy';
import { appConnectors, createAppCtx, DISTRU_MCP_ID, type AppCtx } from '../harness/registry';
import { OpsMcpServers } from '../mastra/mcp/ops-mcp';
import { afterDecision, afterPropose, sendProposalApproved } from '../mastra/proposal-executor';
import { restockLauncher } from '../mastra/restock-launcher';
import { createLocationsService } from './locations';
import { appMcpTokens } from './app-mcp-tokens';
import { createPolicyRuleService, DrizzlePolicyRuleRepo } from './policy-rules';
import type { OpSystemsLookup, ProposalService } from './proposals';

export const PUBLIC_URL = env.PUBLIC_URL ?? env.BETTER_AUTH_URL;

/** Decision hook: resume the waiting run, or queue execution when no run will execute the approval. */
export const appAfterDecision = afterDecision({ launcher: restockLauncher, send: sendProposalApproved });

/** After an MCP / agent-tool propose: a run-less auto-approved proposal is executed right away. */
export const appAfterPropose = afterPropose(sendProposalApproved);

/**
 * Connector + reaches per op action, from the current registry and the MCP bridge's classification
 * (e.g. `distru_mcp.mutate_purchase_order` reaches QuickBooks).
 */
export const appOpSystems: OpSystemsLookup = (action) => {
  const ref = appConnectors.registry.connectorOf(action);
  const local = ref?.id === DISTRU_MCP_ID ? action.slice(DISTRU_MCP_ID.length + 1).replace(/\.undo$/, '') : null;
  const bridged = local ? appConnectors.bridgedTools().find((t) => t.names.includes(local)) : undefined;
  return { connector: ref ? { id: ref.id, system: ref.system } : null, reaches: bridged ? [...bridged.classification.reaches] : null };
};

export interface CoreServices {
  proposals: ProposalService;
  audit: ApiServices['audit'];
  runs: ApiServices['runs'];
  connectors: ApiServices['connectors'];
}

export function createOpsServices(core: CoreServices) {
  const policyRules = createPolicyRuleService({ repo: new DrizzlePolicyRuleRepo(db), rules: APP_POLICY_RULES, audit: appAuditSink });
  const locations = createLocationsService(() => {
    const distru = createAppCtx().connectors.distru;
    return distru.listAll(distru.listLocations, {});
  });

  const api: Pick<ApiServices, 'undo' | 'mcpTokens' | 'policyRules' | 'locations'> = {
    undo: {
      propose: async (id, user, input) => {
        const p = await appHarness.undo({
          ctx: createAppCtx(),
          principal: userPrincipal(user.id, user.role, user.name),
          proposalId: id,
          reason: input.reason,
          ...(input.opIndexes ? { opIndexes: input.opIndexes } : {}),
        });
        return core.proposals.detailOf(p);
      },
    },
    mcpTokens: {
      create: (user, input) => appMcpTokens.create(user, input),
      list: () => appMcpTokens.list(),
      revoke: (user, id) => appMcpTokens.revoke(user, id),
      mcpUrl: `${PUBLIC_URL.replace(/\/$/, '')}/mcp`,
    },
    policyRules: { list: () => policyRules.list(), available: () => policyRules.available(), replace: (actor, rules) => policyRules.replace(actor, rules) },
    locations,
  };

  const mcpServers = new OpsMcpServers<AppCtx>({
    registry: () => appConnectors.registry,
    harness: appHarness,
    ctxFor: (intent) => ({ ...createAppCtx(), run: { intent } }),
    proposals: core.proposals,
    audit: { list: core.audit.list, sink: appAuditSink },
    runs: {
      start: (input, triggeredBy) => restockLauncher.start({ triggeredBy, ...input }),
      get: core.runs.get,
    },
    afterPropose: appAfterPropose,
    connectors: async () => (await core.connectors.list()).map((c) => ({ id: c.id, system: c.system, description: c.description, health: c.health })),
    webUrl: env.WEB_ORIGIN[0],
  });
  const mcpRoutes = createMcpHttpRoutes({ tokens: appMcpTokens, servers: mcpServers });

  return { api, mcpServers, mcpRoutes };
}
