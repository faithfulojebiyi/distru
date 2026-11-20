import { type HonoBindings, type HonoVariables, MastraServer } from '@mastra/hono';
import { serve as inngestServe } from '@mastra/inngest';
import { InMemoryTaskStore } from '@mastra/server/a2a/store';
import { sql as dsql } from 'drizzle-orm';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { agentStreamErrorCodes } from './api/agent-errors';
import { A2A_CARD_PATH, publicAgentCard } from './api/a2a-card';
import { createApiRoutes } from './api/routes';
import { mastraRouteAllowlist, studioOriginBypass } from './api/mastra-allowlist';
import type { ApiServices } from './api/services';
import { auth } from './auth/auth';
import { MASTRA_STUDIO_AUTH_PATHS } from './auth/mastra-auth';
import { betterAuthResolver } from './auth/session';
import { db } from './db/client';
import { env } from './env';
import { mastra } from './mastra';
import { createContextFunctions, createRecallFunctions, createRestockFunctions, createVendorReplyFunctions } from './mastra/functions';
import { appContextStore, appContextSync, appRecall } from './context';
import { indexIncomingMessage, indexMailbox } from './context/recall';
import { recallPassDeps, recallSearchService } from './services/recall';
import { learnFromHistory, memoriesList, onboarding, profileSummary, syncAndProfile } from './context/app-context';
import { createEvalsService } from './services/evals';
import { createWebhookRoutes } from './api/webhooks';
import { inngest, RESTOCK_REQUESTED_EVENT } from './mastra/inngest';
import { restockLauncher } from './mastra/restock-launcher';
import { appAuditSink, appHarness } from './harness/app';
import { appConnectors, appContexts, appErrorClassifier, createAppCtx } from './harness/registry';
import { createAppHarness } from './harness/harness';
import { appPolicyEngine } from './harness/policy';
import { createConnectorsService } from './services/connectors';
import { createAuditService, createProposalService } from './services/proposals';
import { createRunsService, dbProposalLinks } from './services/runs';
import { appOnDecided, appOpSystems, appSweepExecutions, createOpsServices } from './services/ops-wiring';
import { createProposalExecutionFunctions } from './mastra/proposal-executor';
import { requestIdMiddleware } from './harness/request-context';
import { toolDescriptorsFor } from './mastra/tools/harness-tools';

export function createServices(): ApiServices & { mcpRoutes: ReturnType<typeof createOpsServices>['mcpRoutes'] } {
  const logger = () => mastra.getLogger();
  const proposals = createProposalService(db, appHarness, createAppCtx, {
    // Resume the workflow run waiting on this proposal (no-op unless suspended); an approval no run
    // will execute (Copilot / MCP / script / undo proposals) is queued for `proposal-execute`.
    onDecided: appOnDecided,
    onHookError: (err, proposalId) =>
      logger()?.error('after-decision hook failed', { proposalId, error: err instanceof Error ? err.message : String(err) }),
    systems: appOpSystems,
  });
  const audit = createAuditService(db);
  const runs = createRunsService({ launcher: restockLauncher, proposalLinks: dbProposalLinks(db) });
  const connectors = createConnectorsService(() => appConnectors.registry, createAppCtx, () => appConnectors.mcpStatus);
  // MCP server + tokens, undo, policy rules, locations (src/services/ops-wiring.ts).
  const ops = createOpsServices({ proposals, audit, runs, connectors });
  return {
    resolveSession: betterAuthResolver(auth),
    demoMode: env.DEMO_MODE,
    checkDatabase: async () => {
      await db.execute(dsql`select 1`);
      return true;
    },
    proposals,
    audit,
    runs,
    connectors,
    ...ops.api,
    mcpRoutes: ops.mcpRoutes,
    evals: createEvalsService(db),
    context: {
      profile: () => profileSummary(appContextStore),
      memories: (q) => memoriesList(appContextStore, q),
      onboarding: () => onboarding(appContextStore),
    },
    recall: recallSearchService(appRecall, env.RECALL_ENABLED),
    // The Ops Lead's tools from the live registry (recall / MCP tools come and go with their connectors).
    copilot: { opsLeadTools: () => toolDescriptorsFor(appConnectors.registry, 'opsLead').map((tool) => tool.name) },
    webhooks: {
      distruSecret: env.DISTRU_WEBHOOK_SECRET,
      distruToleranceSeconds: env.DISTRU_WEBHOOK_TOLERANCE_SECONDS,
      audit: appAuditSink,
      emit: async (event) => {
        await inngest.send({ name: event.name, id: event.id, data: event.data });
      },
    },
  };
}

/**
 * Builds the single Hono app served by Bun:
 *
 *   CORS (credentials, WEB_ORIGIN)
 *   /api/auth/*        Better Auth
 *   /api/inngest       Inngest serve endpoint (Mastra workflows as Inngest functions)
 *   /api/health, /api/me, /api/proposals, /api/audit-events, /api/runs, /api/connectors,
 *   /api/webhooks/distru   custom typed routes
 *   /api/webhooks/composio, /api/webhooks/slack   signed provider webhooks (src/api/webhooks.ts)
 *   /api/mcp-tokens, /api/proposals/:id/undo, /api/policy-rules, /api/locations   (src/api/ops-routes.ts)
 *   /mcp               our MCP server (Streamable HTTP, Bearer ops_mcp_… tokens)
 *   /api/openapi.json  OpenAPI 3.1 for the custom routes (Orval input)
 *   Mastra built-ins, allowlisted (src/api/mastra-allowlist.ts): /api/agents/ops-lead/stream|generate,
 *   /api/memory/threads..., A2A (/api/.well-known/ops-lead/agent-card.json, /api/a2a/ops-lead); others 404
 */
export async function createApp(services: ApiServices & { mcpRoutes?: Hono } = createServices()) {
  const app = new Hono<{ Bindings: HonoBindings; Variables: HonoVariables }>();

  // x-request-id in/out; audit events written during the request carry it (audit_event.request_id).
  app.use('*', requestIdMiddleware);

  // Standalone Mastra Studio (`bun run studio`, http://localhost:3000) is a browser app on another
  // origin: allowed in development only. Production never trusts it.
  const origins = env.NODE_ENV === 'production' ? env.WEB_ORIGIN : [...env.WEB_ORIGIN, ...env.STUDIO_ORIGIN];

  app.use(
    '*',
    cors({
      origin: origins,
      credentials: true,
      allowHeaders: ['Content-Type', 'Authorization', 'x-mastra-client-type', 'x-mastra-dev-playground'],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      exposeHeaders: ['Content-Length', 'set-auth-token'],
      maxAge: 600,
    }),
  );

  // Better Auth owns /api/auth/*, except the few Mastra auth paths Studio calls (capabilities, me,
  // credentials sign-in): those fall through to MastraServer below.
  const mastraAuthPaths = new Set<string>(MASTRA_STUDIO_AUTH_PATHS);
  app.on(['GET', 'POST'], '/api/auth/*', (c, next) => (mastraAuthPaths.has(c.req.path) ? next() : auth.handler(c.req.raw)));

  const functions = [
    ...createRestockFunctions(restockLauncher, { cronEnabled: env.RESTOCK_CRON_ENABLED, cron: env.RESTOCK_CRON }),
    ...createVendorReplyFunctions(restockLauncher),
    ...createContextFunctions({
      cron: env.CONTEXT_SYNC_CRON,
      syncAndProfile: () => syncAndProfile(appContextSync, appContextStore, () => learnFromHistory(db, appContextStore)),
      handleWebhook: (body) => appContextSync.handleWebhook(body),
    }),
    ...(env.RECALL_ENABLED
      ? createRecallFunctions({
          cron: env.RECALL_INDEX_CRON,
          indexMailbox: () => indexMailbox(recallPassDeps()),
          indexIncoming: (event) => indexIncomingMessage(recallPassDeps(), event),
        })
      : []),
    ...createProposalExecutionFunctions({
      harnessFor: (steps) => createAppHarness({ registry: () => appConnectors.registry, errors: appErrorClassifier, policyEngine: appPolicyEngine, steps, config: { undoWindowMs: env.UNDO_WINDOW_HOURS * 3_600_000 } }),
      ctx: () => appContexts().execute,
      sweep: appSweepExecutions,
    }),
  ];
  app.on(['GET', 'POST', 'PUT'], '/api/inngest', inngestServe({ mastra, inngest, functions }));

  app.route('/', createApiRoutes(services));

  // Our MCP server (Streamable HTTP, per-client tokens): /mcp. See src/api/mcp-http.ts.
  if (services.mcpRoutes) app.route('/', services.mcpRoutes);

  // Signed provider webhooks outside the OpenAPI surface: POST /api/webhooks/composio (Composio
  // triggers → Inngest) and POST /api/webhooks/slack (approval buttons). See src/api/webhooks.ts.
  app.route('/', createWebhookRoutes(services));

  // Mastra built-in routes (agents, workflows, memory, observability, ...) under /api.
  // `taskStore` enables Mastra's built-in A2A execution (/api/a2a/:agentId); without it message/send fails.
  // In-memory: a paused A2A task resumes only on the process that started it (Mastra docs).
  // The A2A card publishes the agent's short public description, never its instructions.
  app.use(A2A_CARD_PATH, publicAgentCard(mastra));
  // Agent stream error chunks carry a stable `code` (model_history_invalid, rate_limited, …), so the Copilot
  // maps failures to its own wording instead of showing the provider's raw message.
  const streamErrors = agentStreamErrorCodes((code, error) => mastra.getLogger()?.warn('Agent stream failed', { code, error }));
  app.use('/api/agents/:agentId/stream', streamErrors);
  app.use('/api/agents/:agentId/stream/*', streamErrors);
  // Deny by default: only the Mastra routes the dashboard and A2A use (src/api/mastra-allowlist.ts); every
  // other built-in route (workflow time-travel/restart/start, tool execute, stored agents, logs, ...) is a 404.
  // Registered after all custom routes, so it only sees requests headed for MastraServer. Standalone Studio
  // (STUDIO_ORIGIN) keeps the full API in development only.
  app.use('*', mastraRouteAllowlist(env.NODE_ENV === 'development' ? { bypass: studioOriginBypass(env.STUDIO_ORIGIN) } : {}));
  const mastraServer = new MastraServer({ app, mastra, taskStore: new InMemoryTaskStore() });
  await mastraServer.init();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    mastra.getLogger()?.error('Unhandled error', { error: err.message, stack: err.stack });
    return c.json({ error: 'internal_error', message: 'Internal server error' }, 500);
  });

  return app;
}
