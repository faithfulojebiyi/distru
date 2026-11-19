import { Mastra } from '@mastra/core';
import { MastraStorageExporter, Observability } from '@mastra/observability';
import { PostgresStore } from '@mastra/pg';
import { auth } from '../auth/auth';
import { BetterAuthMastraProvider } from '../auth/mastra-auth';
import { betterAuthResolver } from '../auth/session';
import { env } from '../env';
import { opsAgent } from './agents/ops-agent';
import { helloWorkflow } from './workflows/hello';

/**
 * The Mastra instance. Served by our own Bun + Hono entry (src/index.ts) through @mastra/hono's
 * MastraServer, so `server.port/cors/build` options don't apply here — see src/app.ts.
 */
export const mastra = new Mastra({
  agents: { opsAgent },
  workflows: { helloWorkflow },
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
    auth: new BetterAuthMastraProvider(betterAuthResolver(auth)),
  },
  environment: env.NODE_ENV,
});
