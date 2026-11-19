/**
 * Typed routes for MCP tokens, undo, policy rules and locations. Registered on the same OpenAPIHono
 * instance as the other custom routes (so they are in /api/openapi.json) by `createApiRoutes`.
 */
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { userPrincipal, UndoUnavailableError } from '@ops/harness';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { requireRole, requireUser, type AuthVariables } from '../auth/session';
import { PolicyValidationError } from '../services/policy-rules';
import { toHttpError } from './harness-errors';
import { ErrorResponseSchema, PolicyDeniedResponseSchema, ProposalIdParamsSchema } from './schemas';
import {
  CreateMcpTokenRequestSchema,
  CreateMcpTokenResponseSchema,
  LocationListSchema,
  McpTokenIdParamsSchema,
  McpTokenListSchema,
  McpTokenSchema,
  PolicyRuleListSchema,
  PolicyValidationErrorSchema,
  UndoRequestSchema,
  UndoResponseSchema,
  UndoUnavailableResponseSchema,
  UpdatePolicyRulesRequestSchema,
} from './schemas-ops';
import type { ApiServices } from './services';

export const OPS_SESSION_PATHS = ['/api/mcp-tokens', '/api/mcp-tokens/*', '/api/policy-rules', '/api/locations'];

const json = <T>(schema: T, description: string) => ({ description, content: { 'application/json': { schema } } });
const authed: Array<Record<string, string[]>> = [{ cookieAuth: [] }, { bearerAuth: [] }];
const e401 = json(ErrorResponseSchema, 'Not signed in');
const e403 = json(ErrorResponseSchema, 'Signed in but not allowed');

const createTokenRoute = createRoute({
  method: 'post',
  path: '/api/mcp-tokens',
  operationId: 'createMcpToken',
  tags: ['mcp'],
  summary: 'Create a per-client MCP token (approver only). The token is returned once',
  description: 'Scopes ⊆ read / propose / approve (read implied). The client sends `Authorization: Bearer <token>` to /mcp and acts as `mcp-client:<id>` with exactly these scopes.',
  security: authed,
  middleware: [requireRole('approver')] as const,
  request: { body: { required: true, content: { 'application/json': { schema: CreateMcpTokenRequestSchema } } } },
  responses: { 201: json(CreateMcpTokenResponseSchema, 'Token created'), 400: json(ErrorResponseSchema, 'Invalid body'), 401: e401, 403: e403 },
});

const listTokensRoute = createRoute({
  method: 'get',
  path: '/api/mcp-tokens',
  operationId: 'listMcpTokens',
  tags: ['mcp'],
  summary: 'List MCP tokens (approver only; never the token itself)',
  security: authed,
  middleware: [requireRole('approver')] as const,
  responses: { 200: json(McpTokenListSchema, 'Tokens, newest first'), 401: e401, 403: e403 },
});

const revokeTokenRoute = createRoute({
  method: 'delete',
  path: '/api/mcp-tokens/{id}',
  operationId: 'revokeMcpToken',
  tags: ['mcp'],
  summary: 'Revoke an MCP token (approver only; idempotent). It stops working on the next request',
  security: authed,
  middleware: [requireRole('approver')] as const,
  request: { params: McpTokenIdParamsSchema },
  responses: { 200: json(McpTokenSchema, 'Revoked token'), 401: e401, 403: e403, 404: json(ErrorResponseSchema, 'Not found') },
});

const undoRoute = createRoute({
  method: 'post',
  path: '/api/proposals/{id}/undo',
  operationId: 'undoProposal',
  tags: ['proposals'],
  summary: 'Propose undoing an executed proposal (operator or approver). Creates a NEW proposal that still needs approval',
  description:
    'Calls harness.undo: the executed ops that can be undone become compensating ops of a new proposal (reverse order, `meta.undoOf`), which goes through policy, a human decision (never auto-approved; separation of duties applies) and the executor. Ops that cannot be undone (e.g. a sent email) are listed in `meta.notUndoable`. 409 `undo_unavailable` with the per-op reasons when nothing (or a requested op) can be undone.',
  security: authed,
  middleware: [requireRole('operator', 'approver')] as const,
  request: { params: ProposalIdParamsSchema, body: { required: true, content: { 'application/json': { schema: UndoRequestSchema } } } },
  responses: {
    201: json(UndoResponseSchema, 'Undo proposal created'),
    400: json(ErrorResponseSchema, 'Invalid body, or the record can no longer be undone (e.g. a PO received meanwhile)'),
    401: e401,
    403: e403,
    404: json(ErrorResponseSchema, 'Not found'),
    409: json(z.union([UndoUnavailableResponseSchema, PolicyDeniedResponseSchema, ErrorResponseSchema]), 'Nothing to undo (undo_unavailable) or concurrently modified'),
  },
});

const listPolicyRoute = createRoute({
  method: 'get',
  path: '/api/policy-rules',
  operationId: 'listPolicyRules',
  tags: ['policy'],
  summary: 'Policy rules (harness rule configs) and the rule types the engine knows',
  security: authed,
  middleware: [requireUser] as const,
  responses: { 200: json(PolicyRuleListSchema, 'Rules'), 401: e401 },
});

const putPolicyRoute = createRoute({
  method: 'put',
  path: '/api/policy-rules',
  operationId: 'updatePolicyRules',
  tags: ['policy'],
  summary: 'Replace the policy rule set (approver only). Params are validated against each rule; changes are audited (policy.changed)',
  security: authed,
  middleware: [requireRole('approver')] as const,
  request: { body: { required: true, content: { 'application/json': { schema: UpdatePolicyRulesRequestSchema } } } },
  responses: { 200: json(PolicyRuleListSchema, 'Saved rules'), 400: json(z.union([PolicyValidationErrorSchema, ErrorResponseSchema]), 'Unknown rule or invalid params'), 401: e401, 403: e403 },
});

const listLocationsRoute = createRoute({
  method: 'get',
  path: '/api/locations',
  operationId: 'listLocations',
  tags: ['distru'],
  summary: 'Own Distru locations (ids accepted by POST /api/runs `locationIds`), cached for a few minutes',
  security: authed,
  middleware: [requireUser] as const,
  responses: { 200: json(LocationListSchema, 'Locations'), 401: e401, 503: json(ErrorResponseSchema, 'Distru unreachable') },
});

export function registerOpsRoutes(api: OpenAPIHono<{ Variables: AuthVariables }>, services: ApiServices, session: MiddlewareHandler<{ Variables: AuthVariables }>) {
  for (const path of OPS_SESSION_PATHS) api.use(path, session);
  // /api/proposals/* already resolves the session (covers /undo).

  api.openapi(createTokenRoute, async (c) => {
    const { token, record } = await services.mcpTokens.create(c.get('user')!, c.req.valid('json'));
    return c.json({ token, record, mcpUrl: services.mcpTokens.mcpUrl }, 201);
  });

  api.openapi(listTokensRoute, async (c) => c.json({ items: await services.mcpTokens.list() }, 200));

  api.openapi(revokeTokenRoute, async (c) => {
    const revoked = await services.mcpTokens.revoke(c.get('user')!, c.req.valid('param').id);
    if (!revoked) return c.json({ error: 'not_found', message: 'Token not found' }, 404);
    return c.json(revoked, 200);
  });

  api.openapi(undoRoute, async (c) => {
    try {
      const proposal = await services.undo.propose(c.req.valid('param').id, c.get('user')!, c.req.valid('json'));
      return c.json({ proposal }, 201);
    } catch (err) {
      if (err instanceof UndoUnavailableError) return c.json({ error: 'undo_unavailable' as const, message: err.message, undo: err.info }, 409);
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

  api.openapi(listPolicyRoute, async (c) => c.json({ items: await services.policyRules.list(), available: services.policyRules.available() }, 200));

  api.openapi(putPolicyRoute, async (c) => {
    const user = c.get('user')!;
    try {
      const items = await services.policyRules.replace(userPrincipal(user.id, user.role, user.name), c.req.valid('json').rules);
      return c.json({ items, available: services.policyRules.available() }, 200);
    } catch (err) {
      if (err instanceof PolicyValidationError) return c.json({ error: 'invalid_policy' as const, message: err.message, issues: err.issues }, 400);
      throw err;
    }
  });

  api.openapi(listLocationsRoute, async (c) => {
    try {
      return c.json(await services.locations.list(), 200);
    } catch (err) {
      return c.json({ error: 'distru_unavailable', message: err instanceof Error ? err.message : 'Distru unreachable' }, 503);
    }
  });
}
