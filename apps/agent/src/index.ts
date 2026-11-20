import { createApp } from './app';
import { sql } from './db/client';
import { env } from './env';
import { appConnectors } from './harness/registry';
import { mastra } from './mastra';
import { stopHarnessTracing } from './observability/otel';
import { appSweepExecutions } from './services/ops-wiring';

// Build the registry before serving: connects the Distru MCP bridge from a live tools/list. If the MCP
// server is down this resolves anyway (degraded: no distru_mcp, reported unhealthy, retried on a timer).
const mcp = await appConnectors.start();
console.log(`connectors: ${appConnectors.registry.connectors().map((c) => c.id).join(', ')}${mcp.state === 'connected' ? '' : ` (distru_mcp ${mcp.state}: ${mcp.detail})`}`);

const app = await createApp();

const server = Bun.serve({
  port: env.PORT,
  fetch: app.fetch,
  // Agent/workflow streams can be quiet for a while; Bun's default idle timeout is 10s.
  idleTimeout: 255,
});

console.log(`ops-agent listening on ${server.url} (${env.NODE_ENV})`);
if (!env.ANTHROPIC_API_KEY) console.warn('ANTHROPIC_API_KEY is not set: agent calls will fail until it is.');

// Scheduled workflows, event listeners and the recovery loop only run once workers are started.
await mastra.startWorkers();

// Boot sweep: approvals whose execution could not be queued while we (or Inngest) were down.
void appSweepExecutions().catch((err: unknown) => console.warn(`[sweeper] boot sweep failed: ${err instanceof Error ? err.message : String(err)}`));

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  await server.stop();
  await appConnectors.stop();
  await mastra.shutdown();
  await stopHarnessTracing();
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
