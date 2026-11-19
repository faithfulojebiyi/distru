/** Distru preset: `distru-mutate-product` hooks (per-buyer menu cap) against a fake Distru MCP server. */
import { afterEach, describe, expect, test } from 'bun:test';
import { agentPrincipal, createHarness, InMemoryAuditSink, InMemoryProposalStore, Registry, sequentialIds, StaticPolicyRules, userPrincipal } from '@ops/harness';
import { z } from 'zod';
import { createDistruMcpConnector, mcpErrorClassifier } from '../src';
import { startServer, type TestServer } from './server';

const planner = agentPrincipal('planner');
const approver = userPrincipal('u-approver', 'approver');
const common = { intent: z.string().min(1), userSatisfactionEstimate: z.number().int().min(1).max(5) };

interface Product {
  id: string;
  name: string;
  sku: string;
  unitsPerCase: string | null;
  maxMenuBuyerOrderQuantity: number | null;
}

function fakeDistru() {
  const products = new Map<string, Product>([['prd_42', { id: 'prd_42', name: 'Blue Dream Live Resin Cart 1g', sku: 'VAP-BD-1G', unitsPerCase: '12.000000', maxMenuBuyerOrderQuantity: null }]]);
  const lookup = (id: string) => products.get(id.startsWith('prd_') ? id : `prd_${id}`);
  /** When set, the next mutate silently stores this value instead (verify must catch it). */
  const tamper = { value: undefined as number | null | undefined };
  const server = startServer([
    { name: 'distru-get-product', input: z.object({ id: z.string(), ...common }), handler: (a) => ({ product: lookup(String(a.id)) ?? null }) },
    {
      name: 'distru-mutate-product',
      input: z.object({ action: z.enum(['CREATE', 'UPDATE', 'DELETE']), id: z.string().optional(), maxMenuBuyerOrderQuantity: z.number().int().nullable().optional(), ...common }),
      handler: (a) => {
        const p = lookup(String(a.id));
        if (!p) throw new Error('Product not found');
        if (a.maxMenuBuyerOrderQuantity !== undefined) p.maxMenuBuyerOrderQuantity = tamper.value !== undefined ? tamper.value : (a.maxMenuBuyerOrderQuantity as number | null);
        tamper.value = undefined;
        return { product: p };
      },
    },
  ]);
  return { products, server, tamper };
}

let server: TestServer | null = null;
afterEach(() => {
  server?.stop();
  server = null;
});

async function setup() {
  const fake = fakeDistru();
  server = fake.server;
  const bridge = await createDistruMcpConnector({ url: fake.server.url, key: 'distru_mcp_test' });
  const registry = Registry.fromConnectors([bridge.connector]);
  const harness = createHarness({ registry, store: new InMemoryProposalStore(), audit: new InMemoryAuditSink(), ids: sequentialIds('p'), policyRules: new StaticPolicyRules([]), errors: mcpErrorClassifier });
  return { ...fake, bridge, registry, harness, ctx: { ...bridge.context, run: { intent: 'Allocation guard' } } };
}

const cap = (id: string, n: number | null) => ({ action: 'UPDATE', id, maxMenuBuyerOrderQuantity: n });

describe('Distru MCP preset: mutate-product (menu buyer cap)', () => {
  test('DELETE is split out (high); UPDATE is medium; before via get-product → diff old → new; summary names the cap', async () => {
    const env = await setup();
    expect(env.registry.action('distru_mcp.mutate_product').risk).toBe('medium');
    expect(env.registry.action('distru_mcp.mutate_product_delete').risk).toBe('high');

    // A bare id is accepted (Distru maps it); the diff keeps the id as sent, so only the cap changes.
    const p = await env.harness.propose({ ctx: env.ctx, principal: planner, ops: [{ action: 'distru_mcp.mutate_product', input: cap('42', 24) }] });
    const op = p.ops[0]!;
    expect(op.before).toMatchObject({ id: '42', sku: 'VAP-BD-1G', maxMenuBuyerOrderQuantity: null, unitsPerCase: 12 });
    expect(op.diff).toEqual([{ path: ['maxMenuBuyerOrderQuantity'], kind: 'changed', before: null, after: 24 }]);
    expect(op.summary).toBe('Per-buyer menu cap on VAP-BD-1G Blue Dream Live Resin Cart 1g: no cap → 24 units per order (sales reps exempt)');
    expect(op.value).toBe(0); // moneyless
    expect(p.status).toBe('pending_approval');
  });

  test('execute sets the cap and verifies by read-back; re-execute writes nothing; a later UPDATE back to the old value restores it', async () => {
    const env = await setup();
    const p = await env.harness.propose({ ctx: env.ctx, principal: planner, ops: [{ action: 'distru_mcp.mutate_product', input: cap('prd_42', 24) }] });
    await env.harness.decide({ ctx: env.ctx, principal: approver, proposalId: p.id, decision: 'approve' });
    const done = await env.harness.execute({ ctx: env.ctx, proposalId: p.id });
    expect(done.status).toBe('executed');
    expect(done.ops[0]!.result).toMatchObject({ recordId: 'prd_42', mismatches: [], error: null });
    expect(env.products.get('prd_42')!.maxMenuBuyerOrderQuantity).toBe(24);
    await env.harness.execute({ ctx: env.ctx, proposalId: p.id });
    expect(env.server.callsTo('distru-mutate-product')).toHaveLength(1);

    // Undo = the recorded `before` value written back.
    const before = done.ops[0]!.before as { maxMenuBuyerOrderQuantity: number | null };
    const undo = await env.harness.propose({ ctx: env.ctx, principal: planner, ops: [{ action: 'distru_mcp.mutate_product', input: cap('prd_42', before.maxMenuBuyerOrderQuantity) }] });
    expect(undo.ops[0]!.diff).toEqual([{ path: ['maxMenuBuyerOrderQuantity'], kind: 'changed', before: 24, after: null }]);
    expect(undo.ops[0]!.summary).toContain('24 units → no cap');
  });

  test('verify fails when the stored cap differs from the approved one', async () => {
    const env = await setup();
    const p = await env.harness.propose({ ctx: env.ctx, principal: planner, ops: [{ action: 'distru_mcp.mutate_product', input: cap('prd_42', 24) }] });
    await env.harness.decide({ ctx: env.ctx, principal: approver, proposalId: p.id, decision: 'approve' });
    env.tamper.value = 240;
    const done = await env.harness.execute({ ctx: env.ctx, proposalId: p.id });
    expect(done.status).toBe('failed');
    expect(done.ops[0]!.result?.mismatches).toEqual([{ path: ['maxMenuBuyerOrderQuantity'], expected: 24, actual: 240 }]);
  });

  test('unknown product is refused at propose time', async () => {
    const env = await setup();
    await expect(env.harness.propose({ ctx: env.ctx, principal: planner, ops: [{ action: 'distru_mcp.mutate_product', input: cap('prd_nope', 5) }] })).rejects.toThrow('Product prd_nope not found');
  });
});
