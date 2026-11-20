import { Mastra } from '@mastra/core';
import { MastraStorageExporter, Observability } from '@mastra/observability';
import { PostgresStore } from '@mastra/pg';
import { auth, signInWithEmail } from '../auth/auth';
import { BetterAuthMastraProvider } from '../auth/mastra-auth';
import { a2aTokenResolver } from '../auth/a2a-tokens';
import { appMcpTokens } from '../services/app-mcp-tokens';
import { betterAuthResolver } from '../auth/session';
import { db } from '../db/client';
import { env } from '../env';
import { appHarness, appPolicyRules } from '../harness/app';
import { findProposalByRunId } from '../harness/proposal-store';
import { appConnectors, appContexts } from '../harness/registry';
import { createAgents, modelsFromEnv } from './agents';
import { mcpServers } from './mcp';
import { restockLauncher } from './restock-launcher';
import { afterPropose, sendProposalApproved } from './proposal-executor';
import { scorers } from './scorers';
import { tools } from './tools';
import { helloWorkflow } from './workflows/hello';
import { createRestockWorkflow, type RestockDeps } from './workflows/restock';
import { createVendorReplyWorkflow, type VendorReplyDeps } from './workflows/vendor-reply';
import { appNotifier } from '../slack';
import { loadFastembed, opsLeadMemory } from '../context/recall';

/** What the restock workflow runs against: the app harness (Postgres), the Distru connector, the seeded policy. */
export const restockDeps: RestockDeps = {
  // Getter: the registry is rebuilt when the Distru MCP bridge connects or its tools change.
  get registry() {
    return appConnectors.registry;
  },
  harness: appHarness,
  policyRules: appPolicyRules,
  contexts: appContexts,
  pricing: { inputUsdPerMTok: env.LLM_INPUT_USD_PER_MTOK, outputUsdPerMTok: env.LLM_OUTPUT_USD_PER_MTOK },
  findProposalByRunId: (runId) => findProposalByRunId(db, runId),
  crossTool: { taskOwnerRole: env.RESTOCK_TASK_OWNER_ROLE },
  notifier: appNotifier,
};

/** The vendor-reply loop (Composio Gmail trigger → Vendor Liaison → proposal → approval → execute). */
export const vendorReplyDeps: VendorReplyDeps = {
  get registry() {
    return appConnectors.registry;
  },
  harness: appHarness,
  contexts: appContexts,
  pricing: { inputUsdPerMTok: env.LLM_INPUT_USD_PER_MTOK, outputUsdPerMTok: env.LLM_OUTPUT_USD_PER_MTOK },
  findProposalByRunId: (runId) => findProposalByRunId(db, runId),
  notifier: appNotifier,
  taskOwnerRole: env.RESTOCK_TASK_OWNER_ROLE,
};

/**
 * Ops Lead (supervisor) + Inventory Analyst, Procurement Planner, Compliance Reviewer, Policy Critic.
 * Model ids come from env per agent; ANTHROPIC_API_KEY is only needed when an agent is called.
 */
export const agents = createAgents({
  get registry() {
    return appConnectors.registry;
  },
  harness: appHarness,
  readCtx: () => appContexts().read,
  // A run-less auto-approved proposal (Copilot) is executed right away (Inngest `proposal-execute`).
  afterPropose: afterPropose(sendProposalApproved),
  models: modelsFromEnv(env),
  launcher: restockLauncher,
  // Semantic recall: `recall_search` for the Ops Lead / Planner / Vendor Liaison, and Copilot memory with
  // Mastra semanticRecall over the operator's earlier turns (FastEmbed → pgvector). Off with RECALL_ENABLED=0.
  recall: env.RECALL_ENABLED,
  ...(env.RECALL_ENABLED && env.RECALL_EMBEDDER === 'fastembed' ? { memory: opsLeadMemory(env.DATABASE_URL, await loadFastembed()) } : {}),
});

export const restockWorkflow = createRestockWorkflow(restockDeps);
export const vendorReplyWorkflow = createVendorReplyWorkflow(vendorReplyDeps);

/**
 * The Mastra instance — the central registration point (https://mastra.ai/reference/project-structure):
 * agents/, workflows/, tools/, mcp/ and scorers/ each export what they define and are registered here. Served by our own Bun + Hono entry (src/index.ts) through @mastra/hono's
 * MastraServer, so `server.port/cors/build` options don't apply here — see src/app.ts.
 */
export const mastra = new Mastra({
  agents,
  workflows: { helloWorkflow, restockWorkflow, vendorReplyWorkflow },
  tools,
  scorers,
  mcpServers,
  storage: new PostgresStore({
    id: 'ops-pg',
    connectionString: env.DATABASE_URL,
    // Keep Mastra's tables out of the drizzle-managed `public` schema.
    schemaName: 'mastra',
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'ops-agent',
        requestContextKeys: ['userId'],
        exporters: [new MastraStorageExporter()],
        // PostgresStore has no batch log writes; logs go to stdout via Mastra's logger instead.
        logging: { enabled: false },
      },
    },
  }),
  server: {
    // Built-in routes (/api/agents, /api/workflows, ...) require a Better Auth session.
    // In development the provider also backs Studio's email/password login form (see README).
    auth: new BetterAuthMastraProvider(
      betterAuthResolver(auth),
      env.NODE_ENV === 'production' ? undefined : signInWithEmail,
      // A2A (agent card + /api/a2a/:agentId) also accepts per-client MCP tokens (src/auth/a2a-tokens.ts).
      a2aTokenResolver(appMcpTokens),
    ),
  },
  environment: env.NODE_ENV,
});

restockLauncher.bind(mastra);
