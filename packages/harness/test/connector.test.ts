import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  createHarness,
  defineAction,
  defineConnector,
  defineReadTool,
  InMemoryAuditSink,
  InMemoryProposalStore,
  mcpClientPrincipal,
  Registry,
  StaticPolicyRules,
  type ConnectorContext,
  type ConnectorDefinition,
  type ConnectorsContext,
} from '../src';
import { agent, approver, FakeErp, purchaseUpsertAction, PurchaseUpsertInput, type Ctx, type PurchasePayload } from './fixtures';

// --- two connectors, each reading its own client from ctx.connectors ---------------------------

interface Mailer {
  sent: string[];
}
type ErpCtx = ConnectorContext<'erp', FakeErp>;
type MailCtx = ConnectorContext<'mail', Mailer>;

const erpConnector = defineConnector<ErpCtx>({
  id: 'erp',
  system: 'erp',
  description: 'Fake ERP',
  readTools: [
    defineReadTool({
      name: 'purchase_get',
      description: 'Get a purchase',
      input: z.object({ id: z.string() }),
      run: async (ctx: ErpCtx, input) => ctx.connectors.erp.get(input.id),
    }),
  ],
  actions: [
    defineAction({
      name: 'purchases.upsert',
      resource: 'purchases',
      description: 'Create or update a purchase order',
      risk: 'medium',
      input: PurchaseUpsertInput,
      plan: (_ctx: ErpCtx, input): PurchasePayload => ({ vendorId: input.vendorId, items: input.items }),
      valueOf: (payload) => (payload.items ?? []).reduce((sum, i) => sum + i.quantity * i.unitPrice, 0),
      summarize: (input, _payload, ctx) => `PO for ${input.items.length} line(s) from ${input.vendorId} (${ctx.connectors.erp.writes} writes so far)`,
      loadBefore: async (ctx: ErpCtx, input) => (input.purchaseId ? ctx.connectors.erp.get(input.purchaseId) : null),
      execute: async (ctx: ErpCtx, payload, key) => {
        const record = ctx.connectors.erp.upsert(payload, key);
        return { recordId: record.id, record };
      },
      verify: async () => ({ ok: true, mismatches: [] }),
      findByIdempotencyKey: async (ctx: ErpCtx, key) => {
        const record = ctx.connectors.erp.findByRef(key);
        return record ? { recordId: record.id, record } : null;
      },
    }),
  ],
  health: async (ctx) => ({ ok: ctx.connectors.erp.writes >= 0, detail: 'reachable' }),
});

const mailConnector = defineConnector<MailCtx>({
  id: 'mail',
  system: 'email',
  description: 'Fake outbox',
  readTools: [
    defineReadTool({
      name: 'outbox',
      description: 'Sent messages',
      input: z.object({}),
      run: async (ctx: MailCtx) => ctx.connectors.mail.sent,
    }),
  ],
  health: async () => {
    throw new Error('SMTP down');
  },
});

const makeCtx = () => ({ connectors: { erp: new FakeErp(), mail: { sent: ['hello'] } }, tenantId: 't1' });

describe('connectors', () => {
  test('defineConnector validates id and system', () => {
    expect(() => defineConnector({ id: 'Bad-Id', system: 'erp', description: '' })).toThrow('Invalid connector id');
    expect(() => defineConnector({ id: 'ok', system: 'fax' as 'erp', description: '' })).toThrow();
    expect(defineConnector({ id: 'empty', system: 'other', description: 'x' })).toMatchObject({ kind: 'connector', readTools: [], actions: [] });
  });

  test('fromConnectors namespaces names and tags the catalog with connector id/system', () => {
    const registry = Registry.fromConnectors([erpConnector, mailConnector]);
    expect(registry.readTools().map((t) => t.name)).toEqual(['erp.purchase_get', 'mail.outbox']);
    expect(registry.actions().map((a) => a.name)).toEqual(['erp.purchases.upsert']);
    const catalog = registry.catalog();
    expect(catalog.map((t) => t.toolName)).toEqual(['erp_purchase_get', 'mail_outbox', 'propose_erp_purchases_upsert']);
    expect(catalog.find((t) => t.toolName === 'mail_outbox')?.connector).toEqual({ id: 'mail', system: 'email' });
    expect(catalog.find((t) => t.kind === 'action')).toMatchObject({ connector: { id: 'erp', system: 'erp' }, risk: 'medium' });
    expect(registry.connectorOf('erp.purchases.upsert')).toEqual({ id: 'erp', system: 'erp' });
    expect(registry.connectors()).toEqual([
      { id: 'erp', system: 'erp', description: 'Fake ERP', readTools: ['erp.purchase_get'], actions: ['erp.purchases.upsert'] },
      { id: 'mail', system: 'email', description: 'Fake outbox', readTools: ['mail.outbox'], actions: [] },
    ]);
    // Read-only principals do not see propose tools from any connector.
    expect(registry.catalog(mcpClientPrincipal('ro', ['read'])).map((t) => t.toolName)).toEqual(['erp_purchase_get', 'mail_outbox']);
  });

  test('plain registrations and connectors coexist; collisions and duplicate connectors are rejected', () => {
    const registry = new Registry<Ctx & ErpCtx>({ actions: [purchaseUpsertAction()], connectors: [erpConnector] });
    expect(registry.actions().map((a) => a.name)).toEqual(['purchases.upsert', 'erp.purchases.upsert']);
    expect(registry.catalog().find((t) => t.name === 'purchases.upsert')?.connector).toBeUndefined();
    expect(() => registry.addConnector(erpConnector)).toThrow('Duplicate connector');
    const clash = defineReadTool({ name: 'erp.purchase_get', description: '', input: z.object({}), run: async () => null });
    expect(() => new Registry<ErpCtx>({ readTools: [clash], connectors: [erpConnector] })).toThrow('Duplicate');
  });

  test('each connector reads its own client from ctx; the harness runs connector actions end to end', async () => {
    const registry = Registry.fromConnectors([erpConnector, mailConnector]);
    const ctx = makeCtx();
    expect(await registry.runReadTool(ctx, agent, 'mail.outbox', {})).toEqual(['hello']);
    const harness = createHarness({ registry, store: new InMemoryProposalStore(), audit: new InMemoryAuditSink(), policyRules: new StaticPolicyRules() });
    const proposal = await harness.propose({
      ctx,
      principal: agent,
      ops: [{ action: 'erp.purchases.upsert', input: { vendorId: 'v1', items: [{ productId: 'p1', quantity: 2, unitPrice: 3 }] } }],
    });
    expect(proposal.ops[0]).toMatchObject({ action: 'erp.purchases.upsert', value: 6, summary: 'PO for 1 line(s) from v1 (0 writes so far)' });
    await harness.decide({ ctx, principal: approver, proposalId: proposal.id, decision: 'approve' });
    const done = await harness.execute({ ctx, proposalId: proposal.id });
    expect(done.status).toBe('executed');
    expect(ctx.connectors.erp.writes).toBe(1);
  });

  test('health aggregates connector probes; throwing probes report not ok', async () => {
    const registry = Registry.fromConnectors([erpConnector, mailConnector]);
    expect(await registry.health(makeCtx())).toEqual([
      { id: 'erp', system: 'erp', ok: true, detail: 'reachable' },
      { id: 'mail', system: 'email', ok: false, detail: 'SMTP down' },
    ]);
  });

  test('context types compose (compile-time checks)', () => {
    type Both = ConnectorsContext<[typeof erpConnector, typeof mailConnector]>;
    const both: Both = makeCtx();
    // @ts-expect-error — missing the mail client
    const missing: Both = { connectors: { erp: new FakeErp() } };
    // A connector is only accepted by a registry whose ctx provides its client.
    const ok: ConnectorDefinition<ErpCtx & { tenantId: string }> = erpConnector;
    // @ts-expect-error — MailCtx does not provide ctx.connectors.erp
    const bad: ConnectorDefinition<MailCtx> = erpConnector;
    // @ts-expect-error — Registry<MailCtx> cannot hold the erp connector
    new Registry<MailCtx>({ connectors: [erpConnector] });
    const neverCalled = () =>
      // @ts-expect-error — runReadTool needs a ctx with both clients
      Registry.fromConnectors([erpConnector, mailConnector]).runReadTool({ connectors: { erp: new FakeErp() } }, agent, 'mail.outbox', {});
    expect(typeof neverCalled).toBe('function');
    expect([both, missing, ok, bad].length).toBe(4);
  });
});
