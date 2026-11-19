/**
 * Our MCP server end to end with the MCP SDK client (Streamable HTTP, in-process): token auth,
 * per-principal tool lists, intent audit, cursor paging, propose → decide with scopes and
 * separation of duties, undo over MCP.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { agentPrincipal, ForbiddenError } from '@ops/harness';
import { z } from 'zod';
import { errorTextOf, mcpEnv, resultOf, type McpEnv } from './fixtures/mcp-env';

let env: McpEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const INTENT = 'Check stock before the Monday restock';

async function poInput(e: McpEnv, quantity = 120) {
  const bd = z.object({ id: z.string(), vendor: z.object({ id: z.string() }) }).parse(await e.registry.runReadTool(e.distru, agentPrincipal('t'), 'distru.products_get', { sku: 'FLW-BD-35' }));
  const loc = (await e.distru.connectors.distru.listLocations({})).data![0]!;
  return { vendor_id: bd.vendor.id, location_id: loc.id, lines: [{ product_id: bd.id, quantity, unit_price: 14 }], notes: 'From Claude Code' };
}

const ProposeResult = z.object({ proposalId: z.string(), status: z.string(), policy: z.object({ outcome: z.string() }), ops: z.array(z.object({ diff: z.string(), summary: z.string().nullable() })) });

describe('auth', () => {
  test('no token / unknown token / revoked token → 401; a Better Auth session is not accepted', async () => {
    env = await mcpEnv();
    const post = (auth?: string) =>
      env!.app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(auth ? { authorization: auth } : {}) }, body: '{}' });
    expect((await post()).status).toBe(401);
    expect((await post('Bearer ops_mcp_nope')).status).toBe(401);
    expect((await post('Bearer some-better-auth-session')).status).toBe(401);
    const { token, record } = await env.tokens.create({ id: 'u-ap' }, { name: 'laptop', scopes: ['read'] });
    await env.connect(token); // works
    await env.tokens.revoke({ id: 'u-ap' }, record.id);
    expect((await post(`Bearer ${token}`)).status).toBe(401);
    await expect(env.connect(token)).rejects.toThrow();
    expect(env.audit.ofType('mcp_token.created')).toHaveLength(1);
    expect(env.audit.ofType('mcp_token.revoked')).toHaveLength(1);
  });
});

describe('tools per principal', () => {
  test('read-only token: get_me + read tools + proposal/audit/run reads; no propose_*, no decide', async () => {
    env = await mcpEnv();
    const client = await env.connect(await env.tokenWith('Codex (read)', ['read']));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['get_me', 'distru_velocity_report', 'distru_inventory', 'list_proposals', 'get_proposal', 'list_audit_events', 'get_run']));
    expect(names.some((n) => n.startsWith('propose_'))).toBe(false);
    expect(names).not.toContain('decide_proposal');
    expect(names).not.toContain('start_restock_run');

    // Every tool requires `intent` (Distru convention).
    const inv = (await client.listTools()).tools.find((t) => t.name === 'distru_inventory')!;
    expect(inv.inputSchema.required).toContain('intent');

    const me = z
      .object({ principal: z.object({ kind: z.literal('mcp-client'), scopes: z.array(z.string()) }), can: z.object({ propose: z.boolean(), approve: z.boolean() }), token: z.object({ name: z.string() }) })
      .parse(resultOf(await client.callTool({ name: 'get_me', arguments: { intent: 'bootstrap' } })));
    expect(me).toMatchObject({ principal: { scopes: ['read'] }, can: { propose: false, approve: false }, token: { name: 'Codex (read)' } });

    // A read tool goes through registry.runReadTool with the client's principal.
    const stock = await client.callTool({ name: 'distru_inventory', arguments: { intent: INTENT, skus: ['FLW-BD-35'] } });
    expect(stock.isError).toBeFalsy();

    // Calling a propose tool that is not in its list fails; nothing is proposed.
    await expect(client.callTool({ name: 'propose_distru_purchases_upsert', arguments: { intent: INTENT, ...(await poInput(env)) } })).rejects.toThrow(/Unknown tool/);
    expect(await env.store.list()).toHaveLength(0);

    // Intent is audited for every call, with the token id.
    const calls = env.audit.ofType('mcp.tool_called');
    expect(calls.find((c) => c.data.tool === 'distru_inventory')!.data).toMatchObject({ intent: INTENT, outcome: 'ok' });
    expect(calls[0]!.actor).toMatchObject({ kind: 'mcp-client' });
  });

  test('missing intent is rejected by the input schema', async () => {
    env = await mcpEnv();
    const client = await env.connect(await env.tokenWith('read', ['read']));
    const r = await client.callTool({ name: 'get_me', arguments: {} });
    expect(r.isError).toBe(true);
  });
});

describe('propose → decide', () => {
  test('propose token creates a pending proposal (never writes); approve token decides; the proposer cannot decide its own', async () => {
    env = await mcpEnv();
    const writer = await env.connect(await env.tokenWith('Claude Code (propose)', ['read', 'propose']));
    const names = (await writer.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['propose_distru_purchases_upsert', 'propose_distru_tasks_create', 'propose_undo', 'start_restock_run']));
    expect(names).not.toContain('decide_proposal');

    const before = (await env.mock.app.request('/__mock/state')).ok;
    expect(before).toBe(true);
    const out = ProposeResult.parse(resultOf(await writer.callTool({ name: 'propose_distru_purchases_upsert', arguments: { intent: 'Restock Blue Dream for Oakland', ...(await poInput(env)) } })));
    expect(out.status).toBe('pending_approval'); // $1,680 ≥ $500 auto-approve threshold
    expect(out.policy.outcome).toBe('needs_approval');
    expect(out.ops[0]!.diff).toContain('+ items');
    const stored = (await env.store.get(out.proposalId))!;
    expect(stored.createdBy).toMatchObject({ kind: 'mcp-client', scopes: ['read', 'propose'] });
    expect(stored.meta).toMatchObject({ source: 'mcp', intent: 'Restock Blue Dream for Oakland' });
    expect(stored.ops[0]!.status).toBe('pending');

    // Paging: list_proposals with cursor.
    ProposeResult.parse(resultOf(await writer.callTool({ name: 'propose_distru_purchases_upsert', arguments: { intent: 'second', ...(await poInput(env, 200)) } })));
    const page1 = z.object({ items: z.array(z.object({ id: z.string() })), hasMore: z.boolean(), nextCursor: z.string().nullable() }).parse(
      resultOf(await writer.callTool({ name: 'list_proposals', arguments: { intent: 'inbox', limit: 1 } })),
    );
    expect(page1).toMatchObject({ hasMore: true });
    const page2 = z.object({ items: z.array(z.object({ id: z.string() })), hasMore: z.boolean() }).parse(
      resultOf(await writer.callTool({ name: 'list_proposals', arguments: { intent: 'inbox', limit: 1, cursor: page1.nextCursor! } })),
    );
    expect(page2.hasMore).toBe(false);
    expect(new Set([page1.items[0]!.id, page2.items[0]!.id]).size).toBe(2);

    // get_proposal returns the diff.
    const detail = z.object({ ops: z.array(z.object({ diff: z.array(z.unknown()) })), diffText: z.string() }).parse(
      resultOf(await writer.callTool({ name: 'get_proposal', arguments: { intent: 'review', id: out.proposalId } })),
    );
    expect(detail.ops[0]!.diff.length).toBeGreaterThan(0);

    // An approve-scoped token decides; a token that both proposed and holds approve may not decide its own.
    const both = await env.tokenWith('both', ['read', 'propose', 'approve']);
    const bothClient = await env.connect(both);
    const own = ProposeResult.parse(resultOf(await bothClient.callTool({ name: 'propose_distru_purchases_upsert', arguments: { intent: 'own', ...(await poInput(env, 300)) } })));
    const selfDecide = await bothClient.callTool({ name: 'decide_proposal', arguments: { intent: 'approve my own', id: own.proposalId, decision: 'approve' } });
    expect(selfDecide.isError).toBe(true);
    expect(errorTextOf(selfDecide)).toContain('Separation of duties');

    const approver = await env.connect(await env.tokenWith('Approver bot', ['approve']));
    const decided = z.object({ status: z.string(), decision: z.object({ by: z.object({ kind: z.string() }) }) }).parse(
      resultOf(await approver.callTool({ name: 'decide_proposal', arguments: { intent: 'Matches the reorder plan', id: out.proposalId, decision: 'approve', reason: 'ok' } })),
    );
    expect(decided).toMatchObject({ status: 'approved', decision: { by: { kind: 'mcp-client' } } });
    expect(env.audit.ofType('proposal.decided').at(-1)!.actor).toMatchObject({ kind: 'mcp-client' });
    const decideCall = env.audit.ofType('mcp.tool_called').find((c) => c.data.tool === 'decide_proposal' && c.data.outcome === 'ok')!;
    expect(decideCall.proposalId).toBe(out.proposalId);
  });

  test('small change auto-approves by policy and is handed to the executor hook', async () => {
    env = await mcpEnv();
    const writer = await env.connect(await env.tokenWith('w', ['propose']));
    const out = ProposeResult.parse(resultOf(await writer.callTool({ name: 'propose_distru_purchases_upsert', arguments: { intent: 'tiny top-up', ...(await poInput(env, 10)) } })));
    expect(out.status).toBe('auto_approved');
    expect(env.executed).toEqual([out.proposalId]);
  });

  test('agent principals still cannot approve (harness), whatever the transport', async () => {
    env = await mcpEnv();
    const writer = await env.connect(await env.tokenWith('w', ['propose']));
    const out = ProposeResult.parse(resultOf(await writer.callTool({ name: 'propose_distru_purchases_upsert', arguments: { intent: 'test proposal', ...(await poInput(env)) } })));
    const planner = agentPrincipal('procurement-planner');
    await expect(env.harness.decide({ ctx: env.distru, principal: planner, proposalId: out.proposalId, decision: 'approve' })).rejects.toBeInstanceOf(ForbiddenError);
    // Even a hand-built agent principal claiming approve is refused.
    await expect(
      env.harness.decide({ ctx: env.distru, principal: { kind: 'agent', id: 'rogue', scopes: ['read', 'propose', 'approve'] }, proposalId: out.proposalId, decision: 'approve' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('undo over MCP', () => {
  test('propose_undo on an executed proposal → new pending undo proposal (reason = intent)', async () => {
    env = await mcpEnv();
    const writer = await env.connect(await env.tokenWith('w', ['propose']));
    const out = ProposeResult.parse(resultOf(await writer.callTool({ name: 'propose_distru_purchases_upsert', arguments: { intent: 'test proposal', ...(await poInput(env, 10)) } })));
    await env.harness.execute({ ctx: env.distru, proposalId: out.proposalId });
    const undo = z.object({ proposalId: z.string(), status: z.string(), undoOf: z.string() }).parse(
      resultOf(await writer.callTool({ name: 'propose_undo', arguments: { intent: 'Ordered the wrong SKU', proposalId: out.proposalId } })),
    );
    expect(undo).toMatchObject({ status: 'pending_approval', undoOf: out.proposalId });
    expect((await env.store.get(undo.proposalId))!.rationale).toBe('Ordered the wrong SKU');
  });
});

describe('proposal headlines over MCP', () => {
  test('caller title: validated (accepted as caller, rejected with an error, never rewritten); default: short template + summary', async () => {
    env = await mcpEnv();
    const writer = await env.connect(await env.tokenWith('Claude Code (propose)', ['read', 'propose']));
    const input = await poInput(env); // 120 × $14 = $1,680
    const first = await writer.callTool({ name: 'propose_distru_purchases_upsert', arguments: { intent: 'restock Blue Dream', ...input, title: 'Restock 120 Blue Dream for $1,680', summary: 'One line, 120 units.' } });
    const ok = ProposeResult.parse(resultOf(first));
    expect((await env.store.get(ok.proposalId))!).toMatchObject({ title: 'Restock 120 Blue Dream for $1,680', summary: 'One line, 120 units.', meta: { titleSource: 'caller' } });

    for (const title of ['Restock Blue Dream for $9,999', 'x'.repeat(61), 'Approve this now']) {
      const bad = await writer.callTool({ name: 'propose_distru_purchases_upsert', arguments: { intent: 'restock Blue Dream', ...input, title } });
      expect(bad.isError).toBe(true);
      expect(errorTextOf(bad)).toContain('title/summary rejected');
    }

    const plain = ProposeResult.parse(resultOf(await writer.callTool({ name: 'propose_distru_purchases_upsert', arguments: { intent: 'restock Blue Dream', ...input } })));
    const stored = (await env.store.get(plain.proposalId))!;
    expect(stored.title!.length).toBeLessThanOrEqual(60);
    expect(stored.meta.titleSource).toBe('template');
  });
});
