/**
 * Copilot routes: what the Ops Lead can answer (topics backed by its current tools, with example questions) for the
 * new-chat page. Registered on the same OpenAPIHono instance (so they are in /api/openapi.json) by `createApiRoutes`.
 * Chats themselves are Mastra Memory threads, served by Mastra's built-in /api/memory routes.
 */
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { requireUser, type AuthVariables } from '../auth/session';
import { CopilotCapabilitiesSchema, OPS_LEAD_TOOL_NAMES, copilotCapabilities } from '../mastra/agents/ops-lead-capabilities';
import { ErrorResponseSchema } from './schemas';
import type { ApiServices } from './services';

export const COPILOT_SESSION_PATHS = ['/api/copilot/*'];

const json = <T>(schema: T, description: string) => ({ description, content: { 'application/json': { schema } } });

const capabilitiesRoute = createRoute({
  method: 'get',
  path: '/api/copilot/capabilities',
  operationId: 'getCopilotCapabilities',
  tags: ['copilot'],
  summary: "What the Ops Lead can answer: topics backed by the tools it has right now, example questions, and what it can't do",
  security: [{ cookieAuth: [] }, { bearerAuth: [] }],
  middleware: [requireUser] as const,
  responses: { 200: json(CopilotCapabilitiesSchema, 'Topics (only those with an available tool)'), 401: json(ErrorResponseSchema, 'Not signed in') },
});

export function registerCopilotRoutes(api: OpenAPIHono<{ Variables: AuthVariables }>, services: ApiServices, session: MiddlewareHandler<{ Variables: AuthVariables }>) {
  for (const path of COPILOT_SESSION_PATHS) api.use(path, session);
  api.openapi(capabilitiesRoute, (c) => c.json(copilotCapabilities(services.copilot?.opsLeadTools() ?? OPS_LEAD_TOOL_NAMES), 200));
}
