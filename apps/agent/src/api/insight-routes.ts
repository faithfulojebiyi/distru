/**
 * Read-only "what do we know" routes: eval results, the context layer's account profile and learned
 * memories, and the onboarding report. Registered on the same OpenAPIHono instance (so they are in
 * /api/openapi.json) by `createApiRoutes`. Session required.
 */
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { requireRole, requireUser, type AuthVariables } from '../auth/session';
import { RecallDisabledError } from '../services/recall';
import { ErrorResponseSchema } from './schemas';
import {
  ContextMemoriesQuerySchema,
  ContextMemoryListSchema,
  ContextProfileSchema,
  EvalHistoryQuerySchema,
  EvalHistorySchema,
  EvalListSchema,
  EvalScenarioParamsSchema,
  OnboardingReportSchema,
  RecallSearchQuerySchema,
  RecallSearchResponseSchema,
} from './schemas-insight';
import type { ApiServices } from './services';

export const INSIGHT_SESSION_PATHS = ['/api/evals', '/api/evals/*', '/api/context/*', '/api/onboarding', '/api/recall/*'];

const json = <T>(schema: T, description: string) => ({ description, content: { 'application/json': { schema } } });
const authed: Array<Record<string, string[]>> = [{ cookieAuth: [] }, { bearerAuth: [] }];
const e401 = json(ErrorResponseSchema, 'Not signed in');

const listEvalsRoute = createRoute({
  method: 'get',
  path: '/api/evals',
  operationId: 'listEvals',
  tags: ['evals'],
  summary: 'Latest eval result per scenario (eval_run, written by `bun run evals -- --sink pg`)',
  security: authed,
  middleware: [requireUser] as const,
  responses: { 200: json(EvalListSchema, 'Latest row per scenario'), 401: e401 },
});

const evalHistoryRoute = createRoute({
  method: 'get',
  path: '/api/evals/{scenario}/history',
  operationId: 'getEvalHistory',
  tags: ['evals'],
  summary: "One scenario's eval results over time, newest first",
  security: authed,
  middleware: [requireUser] as const,
  request: { params: EvalScenarioParamsSchema, query: EvalHistoryQuerySchema },
  responses: { 200: json(EvalHistorySchema, 'History (empty for an unknown scenario)'), 401: e401 },
});

const profileRoute = createRoute({
  method: 'get',
  path: '/api/context/profile',
  operationId: 'getContextProfile',
  tags: ['context'],
  summary: 'Account profile from synced Distru data: vendors (promised vs actual lead time, on-time, fill rate, price trends) and products (demand, stock, retail)',
  security: authed,
  middleware: [requireUser] as const,
  responses: { 200: json(ContextProfileSchema, 'Latest profile (available: false before the first sync)'), 401: e401 },
});

const memoriesRoute = createRoute({
  method: 'get',
  path: '/api/context/memories',
  operationId: 'listContextMemories',
  tags: ['context'],
  summary: 'Memories learned from approvals, edits, rejections, vetoes and policy changes (with evidence and decayed confidence)',
  security: authed,
  middleware: [requireUser] as const,
  request: { query: ContextMemoriesQuerySchema },
  responses: { 200: json(ContextMemoryListSchema, 'Memories, most confident first'), 401: e401 },
});

const onboardingRoute = createRoute({
  method: 'get',
  path: '/api/onboarding',
  operationId: 'getOnboardingReport',
  tags: ['context'],
  summary: 'Onboarding report: data completeness, vendors missing lead times, suggested starting policy (deterministic, with evidence)',
  security: authed,
  middleware: [requireUser] as const,
  responses: { 200: json(OnboardingReportSchema, 'Report'), 401: e401 },
});

const recallSearchRoute = createRoute({
  method: 'get',
  path: '/api/recall/search',
  operationId: 'searchRecall',
  tags: ['context'],
  summary: 'Semantic search over vendor email, vendor replies and PO notes: passages with date, vendor, PO numbers and a citation ref; text wrapped as untrusted, injection-like text flagged suspicious',
  security: authed,
  middleware: [requireRole('operator', 'approver')] as const,
  request: { query: RecallSearchQuerySchema },
  responses: {
    200: json(RecallSearchResponseSchema, 'Passages, best first (at most `limit`, one per document)'),
    401: e401,
    403: json(ErrorResponseSchema, 'Role not allowed'),
    503: json(ErrorResponseSchema, 'Recall disabled or the index is unavailable'),
  },
});

export function registerInsightRoutes(api: OpenAPIHono<{ Variables: AuthVariables }>, services: ApiServices, session: MiddlewareHandler<{ Variables: AuthVariables }>) {
  for (const path of INSIGHT_SESSION_PATHS) api.use(path, session);

  api.openapi(listEvalsRoute, async (c) => c.json({ items: await services.evals.latest() }, 200));

  api.openapi(evalHistoryRoute, async (c) => {
    const { scenario } = c.req.valid('param');
    return c.json({ scenario, items: await services.evals.history(scenario, c.req.valid('query').limit) }, 200);
  });

  api.openapi(profileRoute, async (c) => c.json(await services.context.profile(), 200));

  api.openapi(memoriesRoute, async (c) => c.json({ items: await services.context.memories(c.req.valid('query')) }, 200));

  api.openapi(onboardingRoute, async (c) => c.json(OnboardingReportSchema.parse(await services.context.onboarding()), 200));

  api.openapi(recallSearchRoute, async (c) => {
    const q = c.req.valid('query');
    try {
      const result = await services.recall.search({
        query: q.q,
        limit: q.limit,
        ...(q.vendorId ? { vendorIds: [q.vendorId] } : {}),
        ...(q.since ? { since: q.since } : {}),
        ...(q.source ? { sources: [q.source] } : {}),
      });
      return c.json(result, 200);
    } catch (err) {
      if (err instanceof RecallDisabledError) return c.json({ error: 'recall_disabled', message: err.message }, 503);
      return c.json({ error: 'recall_unavailable', message: err instanceof Error ? err.message : String(err) }, 503);
    }
  });
}
