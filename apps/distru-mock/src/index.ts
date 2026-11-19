import { createMockServer } from './app';
import { isScenario } from './seed';

const env = process.env;
const scenario = env.MOCK_SCENARIO ?? 'default';
if (!isScenario(scenario)) throw new Error(`Unknown MOCK_SCENARIO "${scenario}"`);

const mock = createMockServer({
  token: env.DISTRU_MOCK_TOKEN ?? 'mock-token',
  scenario,
  now: env.MOCK_NOW,
  pageSize: env.MOCK_PAGE_SIZE ? Number(env.MOCK_PAGE_SIZE) : 25,
  webhookUrl: env.WEBHOOK_URL || undefined,
  webhookSecret: env.WEBHOOK_SECRET ?? 'mock-webhook-secret',
  publicUrl: env.MOCK_PUBLIC_URL || undefined,
  mcpKey: env.DISTRU_MCP_MOCK_KEY || undefined,
  webhookRetryDelaysMs: env.MOCK_WEBHOOK_RETRY_DELAYS_MS ? env.MOCK_WEBHOOK_RETRY_DELAYS_MS.split(',').map(Number) : undefined,
  rateLimit: {
    every: env.MOCK_RATE_LIMIT_EVERY ? Number(env.MOCK_RATE_LIMIT_EVERY) : 0,
    retry_after: env.MOCK_RATE_LIMIT_RETRY_AFTER ? Number(env.MOCK_RATE_LIMIT_RETRY_AFTER) : 2,
  },
});

const port = Number(env.PORT ?? 4500);
const server = Bun.serve({ port, fetch: mock.app.fetch });
const seed = mock.store.summary;
console.log(
  `[distru-mock] http://localhost:${server.port}/public/v1  mcp=http://localhost:${server.port}/mcp  scenario=${mock.scenario}` +
    `  below-reorder=${seed?.below_reorder_skus.length ?? 0}  webhooks=${env.WEBHOOK_URL || 'off'}`,
);
