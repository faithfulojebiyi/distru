/**
 * Process wiring for the MCP server, MCP tokens, undo, policy rules and locations (kept out of
 * app.ts so the composition root only adds a few lines).
 */
import { userPrincipal, type Proposal } from '@ops/harness';
import { appContextStore } from '../context';
import { auditEventsOf, learnFromDecision, learningAuditSink } from '../context/app-context';
import { createMcpHttpRoutes } from '../api/mcp-http';
import type { ApiServices } from '../api/services';
import { db } from '../db/client';
import { env } from '../env';
import { appAuditSink, appHarness } from '../harness/app';
import { APP_POLICY_RULES } from '../harness/policy';
import { appConnectors, createAppCtx, DISTRU_MCP_ID, type AppCtx } from '../harness/registry';
import { OpsMcpServers } from '../mastra/mcp/ops-mcp';
import {
  afterDecision,
  afterPropose,
  guardedAfterDecision,
  launcherRuns,
  sendProposalApproved,
  sendWithMarker,
  sweepPendingExecutions,
  type SweepResult,
} from '../mastra/proposal-executor';
import { loadProposal } from '../harness/proposal-store';
import { DrizzlePendingExecutionStore, stalledProposals } from './pending-executions';
import { restockLauncher } from '../mastra/restock-launcher';
import { createLocationsService } from './locations';
import { appMcpTokens } from './app-mcp-tokens';
import { createPolicyRuleService, DrizzlePolicyRuleRepo } from './policy-rules';
import type { OpSystemsLookup, ProposalService } from './proposals';

export const PUBLIC_URL = env.PUBLIC_URL ?? env.BETTER_AUTH_URL;

/** Proposals whose execution could not be queued (Inngest unreachable); the sweeper retries them. */
export const appPendingExecutions = new DrizzlePendingExecutionStore(db);
const appRuns = launcherRuns(restockLauncher);

/**
 * Decision hook: resume the waiting run, or queue execution when no run will execute the approval.
 * If Inngest is unreachable the follow-up is recorded as a pending-execution marker (never lost).
 */
export const appAfterDecision = guardedAfterDecision(afterDecision({ runs: appRuns, send: sendProposalApproved }), appPendingExecutions);

/** After an MCP / agent-tool propose: a run-less auto-approved proposal is executed right away (marker if the queue is down). */
export const appAfterPropose = afterPropose(sendWithMarker(sendProposalApproved, appPendingExecutions, 'auto_approval'));

/**
 * The execution sweeper (Inngest cron every minute + once at boot): enqueues approved / auto-approved
 * proposals with no execution started (markers first), idempotently.
 */
export const appSweepExecutions = (): Promise<SweepResult> =>
  sweepPendingExecutions({
    store: appPendingExecutions,
    stalled: (olderThan) => stalledProposals(db, olderThan),
    get: (id) => loadProposal(db, id),
    runs: appRuns,
    send: sendProposalApproved,
    log: (message, meta) => console.log(`[sweeper] ${message} ${JSON.stringify(meta)}`),
  });

/**
 * After every decision: the proposal's audit trail becomes memory-learner signals (idempotent), then the
 * execution follow-up (resume the run / queue execution, with a marker if the queue is down). Learning
 * is best-effort and never blocks the decision's follow-up.
 */
export const appOnDecided = async (p: Proposal): Promise<void> => {
  await learnFromDecision(appContextStore, p, await auditEventsOf(db, p.id)).catch((err: unknown) =>
    console.warn(`[context] learning from decision ${p.id} failed: ${err instanceof Error ? err.message : String(err)}`),
  );
  await appAfterDecision(p);
};

/** POST /api/proposals/:id/resume: audited request (approve scope, failed only), then the durable executor. */
export function createResumeService(proposals: Pick<ProposalService, 'detailOf'>): ApiServices['resume'] {
  const send = sendWithMarker(sendProposalApproved, appPendingExecutions, 'resume');
  return {
    request: async (id, user, input) => {
      const p = await appHarness.requestResume({ principal: userPrincipal(user.id, user.role, user.name), proposalId: id, ...(input.reason ? { reason: input.reason } : {}) });
      // Event id per proposal version: a double click dedupes, a later resume (after another failure) does not.
      const queued = await send(p.id, { eventId: `proposal-resume-${p.id}-v${p.version}`, resume: true }).then(
        () => true,
        () => false,
      );
      return { proposal: await proposals.detailOf(p), queued };
    },
  };
}

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
  // policy.changed is audited and also fed to the memory learner (policy_rule_changed signals).
  const policyAudit = learningAuditSink(appAuditSink, () => appContextStore, (err) => console.warn(`[context] policy signal failed: ${err instanceof Error ? err.message : String(err)}`));
  const policyRules = createPolicyRuleService({ repo: new DrizzlePolicyRuleRepo(db), rules: APP_POLICY_RULES, audit: policyAudit });
  const locations = createLocationsService(() => {
    const distru = createAppCtx().connectors.distru;
    return distru.listAll(distru.listLocations, {});
  });

  const api: Pick<ApiServices, 'undo' | 'resume' | 'mcpTokens' | 'policyRules' | 'locations'> = {
    resume: createResumeService(core.proposals),
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
