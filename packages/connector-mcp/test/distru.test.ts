/** Distru preset against a small fake Distru MCP server (no `_meta`: classification comes from the table). */
import { afterEach, describe, expect, test } from 'bun:test';
import { agentPrincipal, createHarness, InMemoryAuditSink, InMemoryProposalStore, Registry, sequentialIds, StaticPolicyRules, userPrincipal } from '@ops/harness';
import { z } from 'zod';
import { createDistruMcpConnector, DISTRU_TOOL_TABLE, hasMarker, mcpErrorClassifier, stripMarkers } from '../src';
import { startServer, type TestServer } from './server';

const planner = agentPrincipal('planner');
const approver = userPrincipal('u-approver', 'approver');
const common = { intent: z.string().min(1), userSatisfactionEstimate: z.number().int().min(1).max(5) };

interface Po {
  id: string;
  purchaseNumber: string;
  status: string;
  description: string | null;
  supplier: { id: string; name: string };
  intakeLocation: { id: string; name: string };
  orderItems: Array<{ id: string; quantity: string; price: string; product: { id: string; name: string } }>;
}

function fakeDistru() {
  const pos = new Map<string, Po>();
  let n = 0;
  let line = 0;
  const OrderItem = z.object({ id: z.string().optional(), productId: z.string().optional(), quantity: z.union([z.string(), z.number()]).optional(), price: z.union([z.string(), z.number()]).optional() });
  const server = startServer([
    { name: 'distru-get-me', input: z.object({ includePermissions: z.boolean().optional(), ...common }), handler: () => ({ user: { id: 'usr_1' } }) },
    {
      name: 'distru-get-purchase-order',
      input: z.object({ id: z.string(), includeOrderItems: z.boolean().optional(), includeOrderCharges: z.boolean().optional(), ...common }),
      handler: (a) => ({ purchaseOrder: pos.get(String(a.id)) ?? null }),
    },
    {
      name: 'distru-search-purchase-orders',
      input: z.object({ limit: z.number().optional(), status: z.array(z.string()).optional(), sortBy: z.object({ field: z.string(), direction: z.string() }).optional(), ...common }),
      handler: () => ({ items: [...pos.values()].reverse().map(({ id, purchaseNumber, status }) => ({ id, purchaseNumber, status })), hasMore: false }),
    },
    {
      name: 'distru-mutate-purchase-order',
      input: z.object({
        action: z.enum(['CREATE', 'UPDATE', 'DELETE']),
        id: z.string().optional(),
        supplierId: z.string().optional(),
        intakeLocationId: z.string().optional(),
        status: z.enum(['DRAFT', 'PENDING', 'PROCESSING', 'DELIVERING', 'PARTIALLY_RECEIVED', 'COMPLETED']).optional(),
        description: z.string().optional(),
        orderItems: z.array(OrderItem).nullish(),
        ...common,
      }),
      handler: (a) => {
        if (a.action === 'DELETE') {
          pos.delete(String(a.id));
          return { id: a.id };
        }
        const items = (a.orderItems as Array<z.infer<typeof OrderItem>> | undefined)?.map((i) => ({
          id: i.id ?? `poi_${++line}`,
          quantity: Number(i.quantity ?? 0).toFixed(6),
          price: Number(i.price ?? 0).toFixed(6),
          product: { id: i.productId ?? 'prd_?', name: 'Product' },
        }));
        if (a.action === 'CREATE') {
          const po: Po = {
            id: `pur_${++n}`,
            purchaseNumber: `PO-${100 + n}`,
            status: String(a.status ?? 'PENDING'),
            description: typeof a.description === 'string' ? a.description : null,
            // Distru accepts unprefixed ids and returns them prefixed.
            supplier: { id: String(a.supplierId).startsWith('com_') ? String(a.supplierId) : `com_${String(a.supplierId)}`, name: 'Humboldt' },
            intakeLocation: { id: String(a.intakeLocationId), name: 'Main' },
            orderItems: items ?? [],
          };
          pos.set(po.id, po);
          return { purchaseOrder: po };
        }
        const po = pos.get(String(a.id));
        if (!po) throw new Error('Purchase order not found');
        if (typeof a.description === 'string') po.description = a.description;
        if (typeof a.status === 'string') po.status = a.status;
        if (items) po.orderItems = items;
        return { purchaseOrder: po };
      },
    },
  ]);
  return { pos, server };
}

let server: TestServer | null = null;
afterEach(() => {
  server?.stop();
  server = null;
});

async function setup(readOnly = false) {
  const fake = fakeDistru();
  server = fake.server;
  const bridge = await createDistruMcpConnector({ url: fake.server.url, key: 'distru_mcp_test', readOnly });
  const registry = Registry.fromConnectors([bridge.connector]);
  const harness = createHarness({
    registry,
    store: new InMemoryProposalStore(),
    audit: new InMemoryAuditSink(),
    ids: sequentialIds('p'),
    policyRules: new StaticPolicyRules([{ key: 'auto_approve_below', params: { amount: 1_000_000, max_risk: 'medium' } }]),
    errors: mcpErrorClassifier,
  });
  const ctx = { ...bridge.context, run: { intent: 'Restock Blue Dream before the weekend' } };
  return { ...fake, bridge, registry, harness, ctx };
}

describe('Distru MCP preset', () => {
  test('table classification + QuickBooks reach → high risk; names without the distru- prefix; injected fields hidden', async () => {
    expect(Object.values(DISTRU_TOOL_TABLE).filter((t) => t.kind === 'write')).toHaveLength(38);
    const env = await setup();
    const catalog = env.registry.catalog(planner);
    expect(catalog.map((c) => c.toolName).sort()).toEqual([
      'distru_mcp_get_me',
      'distru_mcp_get_purchase_order',
      'distru_mcp_search_purchase_orders',
      'propose_distru_mcp_mutate_purchase_order',
    ]);
    const po = catalog.find((c) => c.toolName === 'propose_distru_mcp_mutate_purchase_order')!;
    expect(po.kind === 'action' && po.risk).toBe('high'); // reaches QuickBooks (so no DELETE split needed)
    expect((po.inputSchema as { required?: string[] }).required).toEqual(['action']);
    expect(env.bridge.tools.find((t) => t.tool === 'distru-mutate-purchase-order')!.classification).toMatchObject({ source: 'table', reaches: ['quickbooks'] });
    expect(env.server.headers.every((h) => h.get('authorization') === 'Bearer distru_mcp_test')).toBe(true);
  });

  test('CREATE: needs approval, intent filled from the run, key stamped, verified by read-back; crash-safe dedupe by marker', async () => {
    const env = await setup();
    const input = { action: 'CREATE', supplierId: 'com_7', intakeLocationId: 'loc_1', description: 'Weekly restock', orderItems: [{ productId: 'prd_1', quantity: 120, price: 14 }] };
    const p = await env.harness.propose({ ctx: env.ctx, principal: planner, ops: [{ action: 'distru_mcp.mutate_purchase_order', input }] });
    expect(p.status).toBe('pending_approval');
    expect(p.ops[0]!).toMatchObject({ risk: 'high', value: 1680, vendorIds: ['com_7'], summary: 'CREATE purchase order new purchase order, 1 line' });
    expect(p.ops[0]!.payload).toMatchObject({ intent: 'Restock Blue Dream before the weekend', userSatisfactionEstimate: 5 });
    await env.harness.decide({ ctx: env.ctx, principal: approver, proposalId: p.id, decision: 'approve' });
    const done = await env.harness.execute({ ctx: env.ctx, proposalId: p.id });
    expect(done.status).toBe('executed');
    expect(done.ops[0]!.result).toMatchObject({ recordId: 'pur_1', deduplicated: false, mismatches: [] });
    const stored = env.pos.get('pur_1')!;
    expect(hasMarker(stored.description, done.ops[0]!.idempotencyKey)).toBe(true);
    expect(stripMarkers(stored.description)).toBe('Weekly restock');

    // The find resolver locates it by marker (as after a crash), so a retry would not call mutate again.
    const action = env.registry.action('distru_mcp.mutate_purchase_order');
    expect(await action.findByIdempotencyKey(env.ctx, done.ops[0]!.idempotencyKey)).toMatchObject({ recordId: 'pur_1' });
    expect(await action.findByIdempotencyKey(env.ctx, 'opk_unknown')).toBeNull();
    expect(env.server.callsTo('distru-mutate-purchase-order')).toHaveLength(1);
  });

  test('verify compares ids prefix-insensitively (Distru returns com_7 for an input of 7)', async () => {
    const env = await setup();
    const p = await env.harness.propose({ ctx: env.ctx, principal: planner, ops: [{ action: 'distru_mcp.mutate_purchase_order', input: { action: 'CREATE', supplierId: '7', intakeLocationId: 'loc_1', orderItems: [{ productId: 'prd_1', quantity: 1, price: 2 }] } }] });
    await env.harness.decide({ ctx: env.ctx, principal: approver, proposalId: p.id, decision: 'approve' });
    const done = await env.harness.execute({ ctx: env.ctx, proposalId: p.id });
    expect(done.status).toBe('executed');
    expect(env.pos.get('pur_1')!.supplier.id).toBe('com_7');
  });

  test('UPDATE: before loaded via get-purchase-order, field-level diff, sparse stamping keeps existing notes', async () => {
    const env = await setup();
    env.pos.set('pur_9', {
      id: 'pur_9',
      purchaseNumber: 'PO-9',
      status: 'PENDING',
      description: 'Call before delivery',
      supplier: { id: 'com_7', name: 'Humboldt' },
      intakeLocation: { id: 'loc_1', name: 'Main' },
      orderItems: [{ id: 'poi_1', quantity: '120.000000', price: '14.000000', product: { id: 'prd_1', name: 'Blue Dream' } }],
    });
    const p = await env.harness.propose({ ctx: env.ctx, principal: planner, ops: [{ action: 'distru_mcp.mutate_purchase_order', input: { action: 'UPDATE', id: 'pur_9', orderItems: [{ id: 'poi_1', quantity: 150 }] } }] });
    expect(p.ops[0]!.before).toMatchObject({ id: 'pur_9', purchaseNumber: 'PO-9', supplierId: 'com_7' });
    expect(p.ops[0]!.diff).toEqual([{ path: ['orderItems', 'id=poi_1', 'quantity'], kind: 'changed', before: 120, after: 150 }]);
    expect(p.ops[0]!.summary).toBe('UPDATE purchase order PO-9, 1 line');
    await env.harness.decide({ ctx: env.ctx, principal: approver, proposalId: p.id, decision: 'approve' });
    const done = await env.harness.execute({ ctx: env.ctx, proposalId: p.id });
    expect(done.status).toBe('executed');
    const desc = env.pos.get('pur_9')!.description;
    expect(stripMarkers(desc)).toBe('Call before delivery');
    expect(hasMarker(desc, done.ops[0]!.idempotencyKey)).toBe(true);
  });

  test('DELETE: diff shows the removed PO; verify confirms it is gone', async () => {
    const env = await setup();
    env.pos.set('pur_5', { id: 'pur_5', purchaseNumber: 'PO-5', status: 'PENDING', description: null, supplier: { id: 'com_7', name: 'H' }, intakeLocation: { id: 'loc_1', name: 'M' }, orderItems: [] });
    const p = await env.harness.propose({ ctx: env.ctx, principal: planner, ops: [{ action: 'distru_mcp.mutate_purchase_order', input: { action: 'DELETE', id: 'pur_5' } }] });
    expect(p.ops[0]!.diff[0]).toMatchObject({ path: [], kind: 'removed' });
    expect(p.ops[0]!.summary).toContain('DELETE purchase order PO-5');
    await env.harness.decide({ ctx: env.ctx, principal: approver, proposalId: p.id, decision: 'approve' });
    expect((await env.harness.execute({ ctx: env.ctx, proposalId: p.id })).status).toBe('executed');
    expect(env.pos.has('pur_5')).toBe(false);
  });

  test('read-only: x-distru-filter-tool-tags: read, no write actions', async () => {
    const env = await setup(true);
    expect(env.server.headers.every((h) => h.get('x-distru-filter-tool-tags') === 'read')).toBe(true);
    expect(env.registry.actions()).toHaveLength(0);
    const me = await env.registry.runReadTool(env.ctx, planner, 'distru_mcp.get_me', {});
    expect(me).toEqual({ user: { id: 'usr_1' } });
    expect(env.server.callsTo('distru-get-me')[0]!.args).toMatchObject({ intent: 'Restock Blue Dream before the weekend', userSatisfactionEstimate: 5 });
  });

  test('env: hosted URL requires DISTRU_MCP_KEY', async () => {
    await expect(createDistruMcpConnector({ env: {} })).rejects.toThrow('DISTRU_MCP_KEY');
  });
});
