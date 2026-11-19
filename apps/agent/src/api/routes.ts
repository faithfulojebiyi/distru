import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { requireRole, requireUser, sessionMiddleware, type AuthVariables } from '../auth/session';
import {
  ConnectorListSchema,
  DistruWebhookHeadersSchema,
  RunDetailSchema,
  RunIdParamsSchema,
  StartRunRequestSchema,
  StartRunResponseSchema,
  WebhookResponseSchema,
  AuditEventListSchema,
  DecisionRequestSchema,
  DecisionResponseSchema,
  ErrorResponseSchema,
  HealthSchema,
  ListAuditEventsQuerySchema,
  ListProposalsQuerySchema,
  ListRunsQuerySchema,
  MeSchema,
  PolicyDeniedResponseSchema,
  ProposalDetailSchema,
  ProposalIdParamsSchema,
  ProposalListSchema,
  RunListSchema,
} from './schemas';
import { ingestWebhook, triggerSource } from '@ops/harness';
import { distruOrderCreatedTrigger, DistruOrderCreatedEventSchema, DISTRU_ORDER_TRIGGER_ID } from './distru-webhook';
import { discardAudit } from './webhook-support';
import { toHttpError } from './harness-errors';
import type { ApiServices } from './services';
import { registerOpsRoutes } from './ops-routes';
import { z } from 'zod';

export const OPENAPI_PATH = '/api/openapi.json';
const SESSION_PATHS = ['/api/me', '/api/proposals', '/api/proposals/*', '/api/audit-events', '/api/runs', '/api/runs/*', '/api/connectors'];

const json = <T>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const errors = {
  401: json(ErrorResponseSchema, 'Not signed in'),
  403: json(ErrorResponseSchema, 'Signed in but not allowed'),
};
const authed: Array<Record<string, string[]>> = [{ cookieAuth: [] }, { bearerAuth: [] }];

// ---------------------------------------------------------------------------
// Route definitions (OpenAPI + validation)
// ---------------------------------------------------------------------------

const healthRoute = createRoute({
  method: 'get',
  path: '/api/health',
  operationId: 'getHealth',
  tags: ['system'],
  summary: 'Liveness + database check',
  responses: { 200: json(HealthSchema, 'Server is up') },
});

const meRoute = createRoute({
  method: 'get',
  path: '/api/me',
  operationId: 'getMe',
  tags: ['auth'],
  summary: 'Current user',
  security: authed,
  middleware: [requireUser] as const,
  responses: { 200: json(MeSchema, 'The signed-in user'), 401: errors[401] },
});

const listProposalsRoute = createRoute({
  method: 'get',
  path: '/api/proposals',
  operationId: 'listProposals',
  tags: ['proposals'],
  summary: 'List proposals (newest first)',
  security: authed,
  middleware: [requireUser] as const,
  request: { query: ListProposalsQuerySchema },
  responses: { 200: json(ProposalListSchema, 'Proposals'), 401: errors[401] },
});

const getProposalRoute = createRoute({
  method: 'get',
  path: '/api/proposals/{id}',
  operationId: 'getProposal',
  tags: ['proposals'],
  summary: 'Proposal detail: ops with diffs, policy evaluation with reasons, status, version, decision',
  security: authed,
  middleware: [requireUser] as const,
  request: { params: ProposalIdParamsSchema },
  responses: {
    200: json(ProposalDetailSchema, 'Proposal'),
    401: errors[401],
    404: json(ErrorResponseSchema, 'Not found'),
  },
});

const decideProposalRoute = createRoute({
  method: 'post',
  path: '/api/proposals/{id}/decision',
  operationId: 'decideProposal',
  tags: ['proposals'],
  summary: 'Approve or reject a proposal (approver only, exactly one decision per proposal)',
  description:
    'Calls harness.decide with the session user as principal (role → scopes). Approve-only `edits` re-plan the edited ops and re-run policy; a deny blocks the approval (409 policy_denied, nothing recorded).',
  security: authed,
  middleware: [requireRole('approver')] as const,
  request: {
    params: ProposalIdParamsSchema,
    body: { required: true, content: { 'application/json': { schema: DecisionRequestSchema } } },
  },
  responses: {
    200: json(DecisionResponseSchema, 'Decision recorded'),
    400: json(ErrorResponseSchema, 'Invalid body or edit input'),
    ...errors,
    404: json(ErrorResponseSchema, 'Not found'),
    409: json(
      z.union([PolicyDeniedResponseSchema, ErrorResponseSchema]),
      'Already decided / concurrently modified (decision_conflict, concurrent_modification), or edits denied by policy (policy_denied)',
    ),
  },
});

const listAuditEventsRoute = createRoute({
  method: 'get',
  path: '/api/audit-events',
  operationId: 'listAuditEvents',
  tags: ['audit'],
  summary: 'Audit trail (newest first by default; filter by proposal / type)',
  security: authed,
  middleware: [requireUser] as const,
  request: { query: ListAuditEventsQuerySchema },
  responses: { 200: json(AuditEventListSchema, 'Audit events'), 401: errors[401] },
});

const listRunsRoute = createRoute({
  method: 'get',
  path: '/api/runs',
  operationId: 'listRuns',
  tags: ['runs'],
  summary: 'Restock workflow runs (newest first), each linked to the proposal it created',
  security: authed,
  middleware: [requireUser] as const,
  request: { query: ListRunsQuerySchema },
  responses: { 200: json(RunListSchema, 'Runs'), 401: errors[401] },
});

const getRunRoute = createRoute({
  method: 'get',
  path: '/api/runs/{id}',
  operationId: 'getRun',
  tags: ['runs'],
  summary: 'Run detail: status, input/result, step timeline with agent calls (tokens, cost, tool calls), linked proposal',
  security: authed,
  middleware: [requireUser] as const,
  request: { params: RunIdParamsSchema },
  responses: {
    200: json(RunDetailSchema, 'Run'),
    401: errors[401],
    404: json(ErrorResponseSchema, 'Not found'),
  },
});

const startRunRoute = createRoute({
  method: 'post',
  path: '/api/runs',
  operationId: 'startRun',
  tags: ['runs'],
  summary: 'Start a restock run (operator or approver). Returns the run id immediately',
  description:
    'Queues the durable restock workflow (Inngest). The run suspends with a proposal waiting for a decision unless policy auto-approves it. Poll GET /api/runs/{id}.',
  security: authed,
  middleware: [requireRole('operator', 'approver')] as const,
  request: { body: { required: false, content: { 'application/json': { schema: StartRunRequestSchema } } } },
  responses: {
    202: json(StartRunResponseSchema, 'Run started'),
    400: json(ErrorResponseSchema, 'Invalid body'),
    ...errors,
    503: json(ErrorResponseSchema, 'Workflow engine unavailable (e.g. Inngest dev server not running)'),
  },
});

const listConnectorsRoute = createRoute({
  method: 'get',
  path: '/api/connectors',
  operationId: 'listConnectors',
  tags: ['connectors'],
  summary: 'Connected systems: live health + tool catalogue (read tools and propose-only actions)',
  security: authed,
  middleware: [requireUser] as const,
  responses: { 200: json(ConnectorListSchema, 'Connectors'), 401: errors[401] },
});

const distruWebhookRoute = createRoute({
  method: 'post',
  path: '/api/webhooks/distru',
  operationId: 'receiveDistruWebhook',
  tags: ['webhooks'],
  summary: 'Distru webhook receiver (HMAC-signed). ORDER CREATE starts a restock run scoped to the ordered products',
  description:
    'Body: Distru webhook envelope `{ type, event, id, object, changes, occurred_datetime }` (raw JSON, verified before parsing). Authenticated by `x-distru-signature: sha256=<hex HMAC-SHA256(raw body, DISTRU_WEBHOOK_SECRET)>`, not by a session.',
  request: { headers: DistruWebhookHeadersSchema },
  responses: {
    200: json(WebhookResponseSchema, 'Accepted (restock requested or ignored)'),
    400: json(ErrorResponseSchema, 'Body is not a Distru webhook'),
    401: json(ErrorResponseSchema, 'Missing or invalid signature'),
  },
});

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

/**
 * Custom API routes with typed request/response schemas. Mounted at the root of the server app;
 * paths are absolute (`/api/...`) so the generated OpenAPI document matches the real URLs.
 */
export function createApiRoutes(services: ApiServices) {
  const api = new OpenAPIHono<{ Variables: AuthVariables }>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: 'validation_error', message: result.error.message }, 400);
      }
    },
  });

  api.openAPIRegistry.registerComponent('securitySchemes', 'cookieAuth', {
    type: 'apiKey',
    in: 'cookie',
    name: 'better-auth.session_token',
  });
  api.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', { type: 'http', scheme: 'bearer' });

  // Resolve the session only on our own routes (not on Mastra / Better Auth / Inngest paths).
  const session = sessionMiddleware(services.resolveSession);
  for (const path of SESSION_PATHS) api.use(path, session);

  api.openapi(healthRoute, async (c) => {
    const dbOk = await services.checkDatabase().catch(() => false);
    return c.json({ status: 'ok' as const, time: new Date().toISOString(), database: dbOk ? ('ok' as const) : ('error' as const) }, 200);
  });

  api.openapi(meRoute, (c) => {
    const user = c.get('user')!;
    return c.json({ id: user.id, email: user.email, name: user.name, role: user.role }, 200);
  });

  api.openapi(listProposalsRoute, async (c) => {
    const items = await services.proposals.list(c.req.valid('query'));
    return c.json({ items }, 200);
  });

  api.openapi(getProposalRoute, async (c) => {
    const found = await services.proposals.get(c.req.valid('param').id);
    if (!found) return c.json({ error: 'not_found', message: 'Proposal not found' }, 404);
    return c.json(found, 200);
  });

  api.openapi(decideProposalRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      const proposal = await services.proposals.decide(id, c.get('user')!, c.req.valid('json'));
      return c.json({ proposal }, 200);
    } catch (err) {
      const mapped = toHttpError(err);
      if (!mapped) throw err;
      switch (mapped.status) {
        case 400:
          return c.json(mapped.body, 400);
        case 403:
          return c.json(mapped.body, 403);
        case 404:
          return c.json(mapped.body, 404);
        case 409:
          return c.json(mapped.body, 409);
      }
    }
  });

  api.openapi(listAuditEventsRoute, async (c) => {
    const items = await services.audit.list(c.req.valid('query'));
    return c.json({ items }, 200);
  });

  api.openapi(listRunsRoute, async (c) => {
    const items = await services.runs.list(c.req.valid('query'));
    return c.json({ items }, 200);
  });

  api.openapi(getRunRoute, async (c) => {
    const run = await services.runs.get(c.req.valid('param').id);
    if (!run) return c.json({ error: 'not_found', message: 'Run not found' }, 404);
    return c.json(run, 200);
  });

  api.openapi(startRunRoute, async (c) => {
    const body = c.req.valid('json') ?? {};
    try {
      const { runId, workflowId } = await services.runs.start(body, c.get('user')!);
      return c.json({ runId, workflowId, status: 'started' as const }, 202);
    } catch (err) {
      return c.json({ error: 'engine_unavailable', message: err instanceof Error ? err.message : 'Could not start the run' }, 503);
    }
  });

  api.openapi(listConnectorsRoute, async (c) => {
    const items = await services.connectors.list();
    return c.json({ items }, 200);
  });

  api.openapi(distruWebhookRoute, async (c) => {
    const raw = await c.req.raw.clone().text();
    // Verify + normalize + audit through the Distru connector's trigger (`distru.order_created`).
    const result = await ingestWebhook(triggerSource([distruOrderCreatedTrigger]), DISTRU_ORDER_TRIGGER_ID, raw, c.req.raw.headers, { DISTRU_WEBHOOK_SECRET: services.webhooks.distruSecret }, {
      audit: services.webhooks.audit ?? discardAudit,
    });
    if (result.status === 'rejected') return c.json({ error: result.reason, message: result.message }, result.httpStatus);
    if (result.status === 'ignored') return c.json({ ok: true as const, action: 'ignored' as const, reason: 'Only ORDER CREATE (with products) triggers a restock' }, 200);
    const order = DistruOrderCreatedEventSchema.parse(result.event.data);
    await services.webhooks.requestRestock({
      triggeredBy: `webhook:distru (ORDER ${order.orderId})`,
      productIds: order.productIds,
      ...(order.locationIds.length ? { locationIds: order.locationIds } : {}),
      scenarioNote: `New sales order ${order.orderId}: check whether the ordered products need restocking.`,
    });
    return c.json({ ok: true as const, action: 'restock_requested' as const, reason: null }, 200);
  });

  // MCP tokens, undo, policy rules, locations (src/api/ops-routes.ts).
  registerOpsRoutes(api, services, session);

  api.doc31(OPENAPI_PATH, {
    openapi: '3.1.0',
    info: {
      title: 'Ops Agent API',
      version: '0.1.0',
      description:
        'Custom routes of the Ops Agent server. Mastra built-in routes (/api/agents, /api/workflows, ...) and Better Auth (/api/auth/*) are not included.',
    },
    servers: [{ url: 'http://localhost:4111' }],
  });

  return api;
}
