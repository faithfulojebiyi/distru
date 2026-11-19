/**
 * A2A: the Ops Lead through Mastra's built-in A2A routes (agent card + JSON-RPC execution), served by
 * @mastra/hono's MastraServer exactly like the app, protected by the same auth provider: a Better
 * Auth session, or a per-client MCP token (card: any valid token; execution: `propose`).
 */
import { describe, expect, test } from 'bun:test';
import { Mastra } from '@mastra/core';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraServer, type HonoBindings, type HonoVariables } from '@mastra/hono';
import { InMemoryTaskStore } from '@mastra/server/a2a/store';
import { InMemoryAuditSink } from '@ops/harness';
import { Hono } from 'hono';
import { a2aTokenResolver } from '../src/auth/a2a-tokens';
import { BetterAuthMastraProvider } from '../src/auth/mastra-auth';
import type { SessionUser } from '../src/auth/session';
import { createOpsLead } from '../src/mastra/agents/ops-lead';
import { createMcpTokenService, InMemoryMcpTokenStore } from '../src/services/mcp-tokens';
import { scriptedModel } from './fixtures/scripted-model';

const operator: SessionUser = { id: 'u-op', email: 'operator@demo.dev', name: 'Op', role: 'operator' };
const CARD = '/api/.well-known/ops-lead/agent-card.json';

async function setup() {
  const tokens = createMcpTokenService({ store: new InMemoryMcpTokenStore(), audit: new InMemoryAuditSink() });
  const opsLead = createOpsLead({ model: scriptedModel('opsLead', () => ({ text: 'Two SKUs are at risk in Oakland.' })), tools: {}, agents: {} });
  const mastra = new Mastra({
    agents: { opsLead },
    storage: new InMemoryStore(),
    logger: false,
    server: {
      auth: new BetterAuthMastraProvider(async (h) => (h.get('authorization') === 'Bearer session-op' ? operator : null), undefined, a2aTokenResolver(tokens)),
    },
  });
  const app = new Hono<{ Bindings: HonoBindings; Variables: HonoVariables }>();
  await new MastraServer({ app, mastra, taskStore: new InMemoryTaskStore() }).init();
  const get = (path: string, auth?: string) => app.request(path, { headers: auth ? { authorization: auth } : {} });
  const send = (auth: string | undefined, text: string) =>
    app.request('/api/a2a/ops-lead', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: { message: { kind: 'message', role: 'user', messageId: crypto.randomUUID(), parts: [{ kind: 'text', text }] } },
      }),
    });
  return { app, tokens, get, send };
}

describe('A2A (Ops Lead)', () => {
  test('agent card needs auth: 401 without; session or MCP token → card with the execution URL', async () => {
    const env = await setup();
    expect((await env.get(CARD)).status).toBe(401);
    expect((await env.get(CARD, 'Bearer ops_mcp_unknown')).status).toBe(401);

    const res = await env.get(CARD, 'Bearer session-op');
    expect(res.status).toBe(200);
    const card = (await res.json()) as { name: string; url: string; description: string; protocolVersion: string };
    expect(card.name).toBe('ops-lead');
    expect(card.url).toEndWith('/api/a2a/ops-lead');
    // Mastra 1.85 builds the card description from the agent's instructions (see README: A2A).
    expect(card.description).toContain('read-only access');

    const { token } = await env.tokens.create({ id: 'u-ap' }, { name: 'partner agent', scopes: ['read'] });
    expect((await env.get(CARD, `Bearer ${token}`)).status).toBe(200);
  });

  test('execution: an MCP token needs propose; MCP tokens never unlock other built-in routes', async () => {
    const env = await setup();
    const { token: readOnly } = await env.tokens.create({ id: 'u-ap' }, { name: 'reader', scopes: ['read'] });
    expect((await env.send(`Bearer ${readOnly}`, 'What is at risk?')).status).toBe(401);
    expect((await env.send(undefined, 'What is at risk?')).status).toBe(401);

    const { token } = await env.tokens.create({ id: 'u-ap' }, { name: 'partner agent', scopes: ['propose'] });
    const res = await env.send(`Bearer ${token}`, 'What is at risk in Oakland?');
    expect(res.status).toBe(200);
    const body = JSON.stringify(await res.json());
    expect(body).toContain('Two SKUs are at risk in Oakland.');

    // The token is A2A-only: the regular agents API still needs a session.
    expect((await env.get('/api/agents', `Bearer ${token}`)).status).toBe(401);
    expect((await env.get('/api/agents', 'Bearer session-op')).status).toBe(200);
  });
});
