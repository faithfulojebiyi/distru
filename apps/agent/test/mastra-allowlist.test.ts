/**
 * The deny-by-default gate in front of Mastra's built-in routes: a signed-in operator reaches only the
 * Copilot (agent stream, memory threads) and A2A; workflow start / time-travel / restart, agent tool
 * execution, stored agents, logs, ... are 404. Custom routes registered before it are unaffected.
 */
import { describe, expect, test } from 'bun:test';
import { Mastra } from '@mastra/core';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraServer, type HonoBindings, type HonoVariables } from '@mastra/hono';
import { InMemoryTaskStore } from '@mastra/server/a2a/store';
import { Hono } from 'hono';
import { z } from 'zod';
import { A2A_CARD_PATH, publicAgentCard } from '../src/api/a2a-card';
import { isAllowedMastraRoute, mastraRouteAllowlist, studioOriginBypass } from '../src/api/mastra-allowlist';
import { BetterAuthMastraProvider } from '../src/auth/mastra-auth';
import type { SessionUser } from '../src/auth/session';
import { createOpsLead } from '../src/mastra/agents/ops-lead';
import { scriptedModel } from './fixtures/scripted-model';

const operator: SessionUser = { id: 'u-op', email: 'operator@demo.dev', name: 'Op', role: 'operator' };
const SESSION = 'Bearer session-op';
const STUDIO = 'http://localhost:3000';

async function setup(options: { studio?: boolean } = {}) {
  let executed = 0;
  const execute = createStep({
    id: 'execute',
    inputSchema: z.object({ proposalId: z.string() }),
    outputSchema: z.object({ ok: z.boolean() }),
    execute: async () => {
      executed++;
      return { ok: true };
    },
  });
  const restockWorkflow = createWorkflow({ id: 'restock', inputSchema: z.object({ proposalId: z.string() }), outputSchema: z.object({ ok: z.boolean() }) }).then(execute).commit();
  const opsLead = createOpsLead({ model: scriptedModel('opsLead', () => ({ text: 'All good.' })), tools: {}, agents: {} });
  const mastra = new Mastra({
    agents: { opsLead },
    workflows: { restockWorkflow },
    storage: new InMemoryStore(),
    logger: false,
    server: { auth: new BetterAuthMastraProvider(async (h) => (h.get('authorization') === SESSION ? operator : null)) },
  });
  const app = new Hono<{ Bindings: HonoBindings; Variables: HonoVariables }>();
  // A custom route registered before the gate (like createApiRoutes in app.ts).
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.get('/api/locations', (c) => c.json({ items: [] }));
  app.use(A2A_CARD_PATH, publicAgentCard(mastra));
  app.use('*', mastraRouteAllowlist(options.studio ? { bypass: studioOriginBypass([STUDIO]) } : {}));
  await new MastraServer({ app, mastra, taskStore: new InMemoryTaskStore() }).init();
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { authorization: SESSION, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return { app, call, executed: () => executed };
}

describe('Mastra route allowlist', () => {
  test('custom routes registered before the gate are untouched', async () => {
    const env = await setup();
    expect((await env.call('GET', '/api/health')).status).toBe(200);
    expect((await env.call('GET', '/api/locations')).status).toBe(200);
  });

  test('workflow time-travel / restart / start / step execution are 404 for a signed-in user, and nothing runs', async () => {
    const env = await setup();
    const forged = { step: 'execute', inputData: { proposalId: 'p-failed', decision: 'approved' } };
    expect((await env.call('POST', '/api/workflows/restockWorkflow/time-travel?runId=r1', forged)).status).toBe(404);
    expect((await env.call('POST', '/api/workflows/restockWorkflow/time-travel-async?runId=r1', forged)).status).toBe(404);
    expect((await env.call('POST', '/api/workflows/restockWorkflow/restart?runId=r1', {})).status).toBe(404);
    expect((await env.call('POST', '/api/workflows/restockWorkflow/start-async', { inputData: { proposalId: 'x' } })).status).toBe(404);
    expect((await env.call('POST', '/api/workflows/restockWorkflow/create-run', {})).status).toBe(404);
    expect((await env.call('POST', '/api/workflows/restockWorkflow/runs/r1/steps/execute', {})).status).toBe(404);
    expect((await env.call('POST', '/api/workflows/vendorReplyWorkflow/start-async', { inputData: {} })).status).toBe(404);
    expect((await env.call('GET', '/api/workflows')).status).toBe(404);
    expect(env.executed()).toBe(0);
  });

  test('agent tool execution is 404 (no proposing as an agent principal through the built-in API)', async () => {
    const env = await setup();
    expect((await env.call('POST', '/api/agents/procurement-planner/tools/propose_distru_purchases_upsert/execute', { data: {} })).status).toBe(404);
    expect((await env.call('POST', '/api/agents/ops-lead/tools/distru_inventory/execute', { data: {} })).status).toBe(404);
    expect((await env.call('POST', '/api/tools/distru_inventory/execute', { data: {} })).status).toBe(404);
  });

  test('other built-ins are 404: agent list, other agents, stored agents, logs, observability, processors', async () => {
    const env = await setup();
    for (const [method, path] of [
      ['GET', '/api/agents'],
      ['GET', '/api/agents/ops-lead'],
      ['POST', '/api/agents/procurement-planner/stream'],
      ['POST', '/api/agents/procurement-planner/generate'],
      ['POST', '/api/agents/ops-lead/approve-tool-call'],
      ['GET', '/api/stored/agents'],
      ['POST', '/api/stored/agents'],
      ['GET', '/api/logs'],
      ['GET', '/api/observability/traces'],
      ['GET', '/api/processors'],
      ['POST', '/api/a2a/procurement-planner'],
      ['GET', '/api/.well-known/procurement-planner/agent-card.json'],
    ] as const) {
      expect({ method, path, status: (await env.call(method, path, method === 'POST' ? {} : undefined)).status }).toEqual({ method, path, status: 404 });
    }
  });

  test('what the dashboard and A2A use still reaches Mastra (and its auth)', async () => {
    const env = await setup();
    const stream = await env.call('POST', '/api/agents/ops-lead/stream', { messages: [{ role: 'user', content: 'Anything at risk?' }], memory: { thread: 't1', resource: 'u-op' } });
    expect(stream.status).toBe(200);
    // The scripted model cannot stream; reaching the agent's run (start … finish) is what matters here.
    expect(await stream.text()).toContain('"type":"finish"');
    expect((await env.call('GET', '/api/memory/threads?agentId=ops-lead&resourceId=u-op')).status).not.toBe(404);
    expect((await env.call('GET', '/api/.well-known/ops-lead/agent-card.json')).status).toBe(200);
    // Allowed routes are still protected by the Mastra auth provider.
    expect((await env.app.request('/api/.well-known/ops-lead/agent-card.json')).status).toBe(401);
  });

  test('allowlist matcher: method and exact path', () => {
    expect(isAllowedMastraRoute('POST', '/api/agents/ops-lead/stream')).toBe(true);
    expect(isAllowedMastraRoute('GET', '/api/agents/ops-lead/stream')).toBe(false);
    expect(isAllowedMastraRoute('POST', '/api/agents/ops-lead/stream/extra')).toBe(false);
    expect(isAllowedMastraRoute('DELETE', '/api/memory/threads/t1')).toBe(true);
    expect(isAllowedMastraRoute('POST', '/api/memory/threads/t1/clone')).toBe(false);
    expect(isAllowedMastraRoute('GET', '/api/memory/threads/t1/messages')).toBe(true);
    expect(isAllowedMastraRoute('POST', '/api/memory/save-messages')).toBe(false);
  });

  test('development Studio bypass: only requests from the Studio origin get the full API', async () => {
    const env = await setup({ studio: true });
    expect((await env.call('GET', '/api/agents', undefined, { origin: STUDIO })).status).toBe(200);
    // The gated routes exist in Mastra (so the 404s above are the gate, not a missing route).
    expect((await env.call('GET', '/api/workflows', undefined, { origin: STUDIO })).status).toBe(200);
    expect((await env.call('GET', '/api/agents', undefined, { origin: 'http://localhost:3050' })).status).toBe(404);
    expect((await env.call('GET', '/api/agents')).status).toBe(404);
  });
});
