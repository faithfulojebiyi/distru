import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { requireRole, requireUser, sessionMiddleware, type AuthVariables } from '../auth/session';
import {
  AuditEventListSchema,
  DecisionRequestSchema,
  DecisionResponseSchema,
  ErrorResponseSchema,
  HealthSchema,
  ListAuditEventsQuerySchema,
  ListProposalsQuerySchema,
  ListRunsQuerySchema,
  MeSchema,
  ProposalDetailSchema,
  ProposalIdParamsSchema,
  ProposalListSchema,
  RunListSchema,
} from './schemas';
import type { ApiServices } from './services';

export const OPENAPI_PATH = '/api/openapi.json';
const SESSION_PATHS = ['/api/me', '/api/proposals', '/api/proposals/*', '/api/audit-events', '/api/runs'];

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
  summary: 'Proposal detail with ops and decision',
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
  summary: 'Approve or reject a proposal (approver only, one decision per proposal)',
  security: authed,
  middleware: [requireRole('approver')] as const,
  request: {
    params: ProposalIdParamsSchema,
    body: { required: true, content: { 'application/json': { schema: DecisionRequestSchema } } },
  },
  responses: {
    200: json(DecisionResponseSchema, 'Decision recorded'),
    ...errors,
    404: json(ErrorResponseSchema, 'Not found'),
    409: json(ErrorResponseSchema, 'Already decided'),
  },
});

const listAuditEventsRoute = createRoute({
  method: 'get',
  path: '/api/audit-events',
  operationId: 'listAuditEvents',
  tags: ['audit'],
  summary: 'Audit trail (newest first)',
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
  summary: 'Workflow runs (placeholder until the run timeline lands)',
  security: authed,
  middleware: [requireUser] as const,
  request: { query: ListRunsQuerySchema },
  responses: { 200: json(RunListSchema, 'Runs'), 401: errors[401] },
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
    const result = await services.proposals.decide(id, c.get('user')!, c.req.valid('json'));
    if (!result.ok) {
      return result.reason === 'not_found'
        ? c.json({ error: 'not_found', message: 'Proposal not found' }, 404)
        : c.json({ error: 'already_decided', message: 'Proposal already has a decision' }, 409);
    }
    return c.json({ proposal: result.proposal, approval: result.approval }, 200);
  });

  api.openapi(listAuditEventsRoute, async (c) => {
    const items = await services.audit.list(c.req.valid('query'));
    return c.json({ items }, 200);
  });

  api.openapi(listRunsRoute, async (c) => {
    const items = await services.runs.list(c.req.valid('query'));
    return c.json({ items }, 200);
  });

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
