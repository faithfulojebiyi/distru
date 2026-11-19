import { type HonoBindings, type HonoVariables, MastraServer } from '@mastra/hono';
import { serve as inngestServe } from '@mastra/inngest';
import { sql as dsql } from 'drizzle-orm';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { createApiRoutes } from './api/routes';
import type { ApiServices } from './api/services';
import { auth } from './auth/auth';
import { MASTRA_STUDIO_AUTH_PATHS } from './auth/mastra-auth';
import { betterAuthResolver } from './auth/session';
import { db } from './db/client';
import { env } from './env';
import { mastra } from './mastra';
import { inngest } from './mastra/inngest';
import { createAppHarness } from './harness/harness';
import { appRegistry, createAppCtx } from './harness/registry';
import { createAuditService, createProposalService } from './services/proposals';

export function createServices(): ApiServices {
  return {
    resolveSession: betterAuthResolver(auth),
    checkDatabase: async () => {
      await db.execute(dsql`select 1`);
      return true;
    },
    proposals: createProposalService(db, createAppHarness({ registry: appRegistry }), createAppCtx),
    audit: createAuditService(db),
    // Placeholder until the run timeline (day 4) reads runs + traces from Mastra storage.
    runs: { list: async () => [] },
  };
}

/**
 * Builds the single Hono app served by Bun:
 *
 *   CORS (credentials, WEB_ORIGIN)
 *   /api/auth/*        Better Auth
 *   /api/inngest       Inngest serve endpoint (Mastra workflows as Inngest functions)
 *   /api/health, /api/me, /api/proposals, /api/audit-events, /api/runs   custom typed routes
 *   /api/openapi.json  OpenAPI 3.1 for the custom routes (Orval input)
 *   /api/agents, /api/workflows, /api/memory, ...   Mastra built-ins (Better Auth session required)
 */
export async function createApp(services: ApiServices = createServices()) {
  const app = new Hono<{ Bindings: HonoBindings; Variables: HonoVariables }>();

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

  app.on(['GET', 'POST', 'PUT'], '/api/inngest', inngestServe({ mastra, inngest }));

  app.route('/', createApiRoutes(services));

  // Mastra built-in routes (agents, workflows, memory, observability, ...) under /api.
  const mastraServer = new MastraServer({ app, mastra });
  await mastraServer.init();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    mastra.getLogger()?.error('Unhandled error', { error: err.message, stack: err.stack });
    return c.json({ error: 'internal_error', message: 'Internal server error' }, 500);
  });

  return app;
}
