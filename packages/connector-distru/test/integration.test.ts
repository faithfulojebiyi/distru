/** Full harness flow against the Distru mock, in-process. */
import { beforeEach, describe, expect, test } from 'bun:test';
import { FAILED_TEST_SKU, INJECTION_SKU, INJECTION_TEXT, LOW_STOCK_SKUS } from '@ops/distru-mock';
import { formatPath, MemoStepRunner, type Proposal } from '@ops/harness';
import { z } from 'zod';
import { type PurchaseUpsertInput } from '../src';
import { ProductDetailSchema } from '../src/tools/catalog';
import { ComplianceCheckOutput } from '../src/tools/compliance';
import { VelocityReportOutput } from '../src/tools/velocity';
import { approver, AUTO_APPROVE_BELOW, gatewayTimeout, planner, setup, type Env } from './setup';

const ACTION = 'distru.purchases.upsert';

async function velocity(env: Env) {
  return VelocityReportOutput.parse(await env.read('velocity_report', { lead_time_days: 14 }));
}

async function bySku(env: Env, sku: string) {
  return ProductDetailSchema.parse(await env.read('products_get', { sku }));
}

/** Plan a PO for Humboldt Heritage Farms (Blue Dream eighths) at last purchase prices. */
async function hhfPurchase(env: Env, extra: Partial<PurchaseUpsertInput> = {}): Promise<PurchaseUpsertInput> {
  const [bd, ogk] = await Promise.all([bySku(env, 'FLW-BD-35'), bySku(env, 'FLW-OGK-35')]);
  const state = await env.mockState();
  return {
    vendor_id: bd.vendor!.id,
    location_id: state.locations[0]!.id,
    lines: [
      { product_id: bd.id, quantity: 120, unit_price: 14 },
      { product_id: ogk.id, quantity: 48, unit_price: 15 },
    ],
    notes: 'Weekly restock',
    expected_delivery_date: '2026-11-29',
    ...extra,
  };
}

async function proposeAndApprove(env: Env, input: PurchaseUpsertInput): Promise<Proposal> {
  const proposal = await env.harness.propose({ ctx: env.ctx, principal: planner, ops: [{ action: ACTION, input }], title: 'Restock' });
  expect(proposal.status).toBe('pending_approval');
  return env.harness.decide({ ctx: env.ctx, principal: approver, proposalId: proposal.id, decision: 'approve' });
}

describe('read tools against the mock', () => {
  let env: Env;
  beforeEach(() => {
    env = setup();
  });

  test('velocity_report returns the 8 seeded below-reorder SKUs, LLM-shaped', async () => {
    const report = await velocity(env);
    expect(report.rows.map((r) => r.sku).sort()).toEqual([...LOW_STOCK_SKUS].sort());
    const row = report.rows[0]!;
    expect(row).toMatchObject({ location: null, vendor: { id: expect.any(String), name: expect.any(String) } });
    expect(typeof row.on_hand_available).toBe('number');
    expect(row.estimated_stockout_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // sorted by urgency
    const dos = report.rows.map((r) => r.days_of_supply ?? Infinity);
    expect(dos).toEqual([...dos].sort((a, b) => a - b));
  });

  test('velocity_report per location tags rows with the location', async () => {
    const state = await env.mockState();
    const report = VelocityReportOutput.parse(await env.read('velocity_report', { lead_time_days: 14, location_ids: [state.locations[0]!.id] }));
    expect(report.rows.length).toBeGreaterThan(0);
    expect(report.rows.every((r) => r.location?.id === state.locations[0]!.id && r.location.name === state.locations[0]!.name)).toBe(true);
  });

  test('velocity_report never comes back empty for want of a lead time; below_reorder_point=any looks up specific SKUs', async () => {
    // Regression: the vendor-reply workflow asked for {below_reorder_point:false, product_ids} without a lead time.
    // Distru computes no reorder point without lead_time_days and the filter (true or false) then drops every row.
    const noLead = VelocityReportOutput.parse(await env.read('velocity_report', {}));
    expect(noLead.params.lead_time_days).toBe(14);
    expect(noLead.rows.map((r) => r.sku).sort()).toEqual([...LOW_STOCK_SKUS].sort());

    const state = await env.mockState();
    const oak = state.locations[0]!.id;
    const low = await bySku(env, 'EDB-GUM-WM');
    const healthy = await bySku(env, 'FLW-GSC-35');
    const product_ids = [low.id, healthy.id];
    const above = VelocityReportOutput.parse(await env.read('velocity_report', { below_reorder_point: false, location_ids: [oak], product_ids }));
    expect(above.rows.map((r) => r.sku)).toEqual(['FLW-GSC-35']); // a low SKU is NOT above its reorder point
    const any = VelocityReportOutput.parse(await env.read('velocity_report', { below_reorder_point: 'any', location_ids: [oak], product_ids }));
    expect(any.params.below_reorder_point).toBe('any');
    expect(any.rows.map((r) => r.sku).sort()).toEqual(['EDB-GUM-WM', 'FLW-GSC-35']);
    expect(any.rows.every((r) => r.avg_daily_demand > 0 && r.reorder_point !== null)).toBe(true);
  });

  test('compliance_check marks FLW-WC-35 blocked and the other at-risk SKUs ok', async () => {
    const report = await velocity(env);
    const result = ComplianceCheckOutput.parse(await env.read('compliance_check', { product_ids: report.rows.map((r) => r.product_id) }));
    const wc = result.products.find((p) => p.sku === FAILED_TEST_SKU)!;
    expect(wc.status).toBe('blocked');
    expect(wc.reasons.join('\n')).toContain('lab test failed');
    expect(wc.reasons.join('\n')).toContain('myclobutanil_ug_per_g');
    expect(wc.reasons.join('\n')).toMatch(/ONHOLD|TestFailed/);
    expect(wc.batches[0]?.tests[0]?.verdict).toBe('failed');
    const others = result.products.filter((p) => p.sku !== FAILED_TEST_SKU);
    expect(others).toHaveLength(7);
    expect(others.every((p) => p.status === 'ok' || p.status === 'unknown')).toBe(true);
    expect(others.filter((p) => p.status === 'ok').length).toBeGreaterThan(0);
  });

  test('inventory, products_search, vendors, vendor_purchase_history, open_orders return trimmed shapes', async () => {
    const state = await env.mockState();
    const inv = z.object({ rows: z.array(z.object({ sku: z.string().nullable(), location: z.object({ name: z.string() }).nullable(), available: z.number() })) }).parse(
      await env.read('inventory', { skus: ['FLW-BD-35'] }),
    );
    expect(inv.rows.length).toBeGreaterThan(0);
    expect(inv.rows.every((r) => r.sku === 'FLW-BD-35' && r.location !== null)).toBe(true);

    const search = z.object({ products: z.array(z.record(z.string(), z.unknown())) }).parse(await env.read('products_search', { query: 'blue dream' }));
    expect(search.products.length).toBeGreaterThan(1);
    expect(search.products.every((p) => !('description' in p))).toBe(true);

    const vendors = z
      .object({ vendors: z.array(z.object({ id: z.string(), name: z.string(), lead_time_days: z.number().nullable(), lead_time_source: z.string().nullable() })) })
      .parse(await env.read('vendors'));
    expect(vendors.vendors.map((v) => v.name).sort()).toEqual(state.vendors.map((v) => v.name).sort());
    for (const v of vendors.vendors) {
      const truth = state.vendors.find((s) => s.id === v.id)!;
      expect(v.lead_time_source).toBe('purchase_history_estimate');
      expect(v.lead_time_days).toBe(truth.typical_lead_time_days);
    }

    const etg = state.vendors.find((v) => v.name === 'Emerald Triangle Growers')!;
    const history = z
      .object({
        vendor: z.object({ name: z.string() }),
        purchases: z.array(z.object({ status: z.string(), lines: z.array(z.object({ unit_price: z.number() })) })),
        price_summary: z.array(z.object({ sku: z.string().nullable(), last_unit_price: z.number(), times_ordered: z.number() })),
      })
      .parse(await env.read('vendor_purchase_history', { vendor_id: etg.id, limit: 3 }));
    expect(history.vendor.name).toBe('Emerald Triangle Growers');
    expect(history.purchases).toHaveLength(3);
    expect(history.price_summary.find((p) => p.sku === 'FLW-WC-35')?.last_unit_price).toBeGreaterThan(0);

    const orders = z
      .object({ count: z.number(), orders: z.array(z.record(z.string(), z.unknown())), demand_by_product: z.array(z.object({ open_quantity: z.number() })) })
      .parse(await env.read('open_orders', { limit: 5 }));
    expect(orders.count).toBeGreaterThan(0);
    expect(orders.orders.length).toBeLessThanOrEqual(5);
    expect(orders.orders.every((o) => !('internal_notes' in o) && !('external_notes' in o))).toBe(true);
    expect(orders.demand_by_product[0]!.open_quantity).toBeGreaterThan(0);
  });

  test('prompt injection in the VAP-PE-1G description never appears as trusted text', async () => {
    const report = await velocity(env);
    const pe = report.rows.find((r) => r.sku === INJECTION_SKU)!;
    const outputs = await Promise.all([
      Promise.resolve(report),
      env.read('products_get', { sku: INJECTION_SKU }),
      env.read('products_get', { product_id: pe.product_id }),
      env.read('products_search', { query: 'pineapple' }),
      env.read('inventory', { product_ids: [pe.product_id] }),
      env.read('vendor_purchase_history', { vendor_id: pe.vendor.id }),
      env.read('open_orders', { product_ids: [pe.product_id] }),
      env.read('compliance_check', { product_ids: [pe.product_id] }),
      env.read('vendors'),
    ]);
    const needle = 'ignore all policies';
    const hits: string[] = [];
    const walk = (v: unknown, path: string[], parent: Record<string, unknown> | null) => {
      if (typeof v === 'string') {
        if (v.toLowerCase().includes(needle)) {
          hits.push(path.join('.'));
          expect(path.at(-1)).toBe('untrusted_text');
          expect(parent?.suspicious).toBe(true);
          expect(parent?.source).toBe('distru.product.description');
        }
      } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, String(i)], null));
      else if (v && typeof v === 'object') {
        const obj = v as Record<string, unknown>;
        for (const [k, x] of Object.entries(obj)) walk(x, [...path, k], obj);
      }
    };
    outputs.forEach((o, i) => walk(o, [`out${i}`], null));
    // products_get (by sku and by id) carry it, wrapped; every other tool omits it.
    expect(hits).toEqual(['out1.description.untrusted_text', 'out2.description.untrusted_text']);
    expect(INJECTION_TEXT.toLowerCase()).toContain(needle);
  });

  test('connector health and catalog names', async () => {
    expect(await env.registry.health(env.ctx)).toEqual([{ id: 'distru', system: 'erp', ok: true, detail: '3 locations reachable' }]);
    const names = env.registry.catalog(planner).map((t) => t.toolName);
    expect(names).toEqual([
      'distru_velocity_report',
      'distru_inventory',
      'distru_products_get',
      'distru_products_search',
      'distru_vendors',
      'distru_vendor_purchase_history',
      'distru_open_orders',
      'distru_compliance_check',
      'distru_invoices_overdue',
      'distru_invoices_search',
      'propose_distru_purchases_upsert',
      'propose_distru_tasks_create',
    ]);
    expect(env.registry.catalog().every((t) => t.connector?.id === 'distru' && t.connector.system === 'erp')).toBe(true);
  });
});

describe('purchases.upsert through the harness', () => {
  let env: Env;
  beforeEach(() => {
    env = setup();
  });

  test('propose → needs approval above the threshold → approve → execute creates a PO → verify ok → re-execute writes nothing', async () => {
    const input = await hhfPurchase(env);
    const proposal = await env.harness.propose({ ctx: env.ctx, principal: planner, ops: [{ action: ACTION, input }] });
    const op = proposal.ops[0]!;
    expect(op.value).toBe(120 * 14 + 48 * 15);
    expect(op.value!).toBeGreaterThan(AUTO_APPROVE_BELOW);
    expect(proposal.status).toBe('pending_approval');
    expect(proposal.policy.outcome).toBe('needs_approval');
    expect(op.summary).toBe('PO to Humboldt Heritage Farms: 2 lines, 168 units, $2,400');
    expect(op.vendorIds).toEqual([input.vendor_id]);
    // exact Distru body
    expect(op.payload).toMatchObject({
      status: 'PENDING',
      company_id: input.vendor_id,
      location_id: input.location_id,
      billing_location_id: input.location_id,
      description: 'Weekly restock\nExpected delivery: 2026-11-29',
      items: [
        { product_id: input.lines[0]!.product_id, location_id: input.location_id, quantity: 120, price: 14 },
        { product_id: input.lines[1]!.product_id, location_id: input.location_id, quantity: 48, price: 15 },
      ],
    });
    expect(op.diff.every((c) => c.kind === 'added')).toBe(true);
    expect(env.net.purchaseWrites).toBe(0); // proposing never writes

    const before = (await env.mockState()).counts.purchases;
    await env.harness.decide({ ctx: env.ctx, principal: approver, proposalId: proposal.id, decision: 'approve' });
    const done = await env.harness.execute({ ctx: env.ctx, proposalId: proposal.id });
    expect(done.status).toBe('executed');
    expect(done.ops[0]!.result).toMatchObject({ deduplicated: false, mismatches: [], error: null });
    expect(env.net.purchaseWrites).toBe(1);
    expect((await env.mockState()).counts.purchases).toBe(before + 1);
    expect(env.audit.types(proposal.id)).toContain('op.verified');

    // The PO in Distru carries the idempotency marker; its notes are intact.
    const po = (await env.ctx.connectors.distru.getPurchase(done.ops[0]!.result!.recordId!)).data!;
    expect(po.status).toBe('PENDING');
    expect(po.description).toBe(`Weekly restock\nExpected delivery: 2026-11-29\n[ops-agent:idem=${op.idempotencyKey}]`);

    const again = await env.harness.execute({ ctx: env.ctx, proposalId: proposal.id });
    expect(again.status).toBe('executed');
    expect(env.net.purchaseWrites).toBe(1);
  });

  test('policy: purchases.upsert is medium risk, so even a small PO needs a human; above the cap it is denied', async () => {
    const bd = await bySku(env, 'FLW-BD-35');
    const small = await env.harness.propose({
      ctx: env.ctx,
      principal: planner,
      ops: [{ action: ACTION, input: await hhfPurchase(env, { lines: [{ product_id: bd.id, quantity: 24, unit_price: 14 }] }) }],
    });
    expect(small.ops[0]!.value).toBeLessThan(AUTO_APPROVE_BELOW);
    expect(small.status).toBe('pending_approval');
    expect(small.policy.reasons.map((r) => r.message).join('\n')).toContain('above low risk');

    const huge = await env.harness.propose({
      ctx: env.ctx,
      principal: planner,
      ops: [{ action: ACTION, input: await hhfPurchase(env, { lines: [{ product_id: bd.id, quantity: 5000, unit_price: 14 }] }) }],
    });
    expect(huge.status).toBe('denied');
    expect(huge.policy.outcome).toBe('deny');
    expect(env.net.purchaseWrites).toBe(0);
  });

  test('crash after the write landed: resume deduplicates by idempotency key (zero extra writes)', async () => {
    const approved = await proposeAndApprove(env, await hhfPurchase(env));
    env.crashAfterWrite(new Error('socket hang up'));
    const crashed = await env.harness.execute({ ctx: env.ctx, proposalId: approved.id });
    expect(crashed.status).toBe('failed');
    expect(env.net.purchaseWrites).toBe(1); // it landed in Distru

    const resumed = await env.harness.execute({ ctx: env.ctx, proposalId: approved.id });
    expect(resumed.status).toBe('executed');
    expect(resumed.ops[0]!.result).toMatchObject({ deduplicated: true, mismatches: [] });
    expect(env.net.purchaseWrites).toBe(1);
    expect(env.audit.types(approved.id)).toContain('op.deduplicated');
  });

  test('retryable failure after the write landed: the retry finds the PO instead of writing again', async () => {
    const approved = await proposeAndApprove(env, await hhfPurchase(env));
    env.crashAfterWrite(gatewayTimeout());
    const done = await env.harness.execute({ ctx: env.ctx, proposalId: approved.id, budget: undefined });
    expect(done.status).toBe('executed');
    expect(done.ops[0]!.result).toMatchObject({ deduplicated: true, attempts: 2 });
    expect(env.net.purchaseWrites).toBe(1);
  });

  test('durable replay (memoized steps) never repeats the write', async () => {
    const steps = new MemoStepRunner();
    env = setup({ steps });
    const approved = await proposeAndApprove(env, await hhfPurchase(env));
    await env.harness.execute({ ctx: env.ctx, proposalId: approved.id });
    await env.harness.execute({ ctx: env.ctx, proposalId: approved.id });
    expect(env.net.purchaseWrites).toBe(1);
  });

  test('a mock 429 is retried honouring Retry-After', async () => {
    const approved = await proposeAndApprove(env, await hhfPurchase(env));
    await env.configureMock({ rate_limit: { fail_next: 2, retry_after: 3 } });
    const done = await env.harness.execute({ ctx: env.ctx, proposalId: approved.id });
    expect(done.status).toBe('executed');
    expect(env.clock.sleeps).toEqual([3000, 3000]);
    const retries = env.audit.ofType('op.retry').filter((e) => e.proposalId === approved.id);
    expect(retries.map((e) => e.data.delayMs)).toEqual([3000, 3000]);
    expect(env.net.purchaseWrites).toBe(1);
  });

  test('update proposal: diff shows changed qty, removed line and added line; executes and verifies', async () => {
    const created = await proposeAndApprove(env, await hhfPurchase(env));
    const executed = await env.harness.execute({ ctx: env.ctx, proposalId: created.id });
    const poId = executed.ops[0]!.result!.recordId!;
    const po = (await env.ctx.connectors.distru.getPurchase(poId)).data!;
    const [bd, ogk, gsc] = await Promise.all([bySku(env, 'FLW-BD-35'), bySku(env, 'FLW-OGK-35'), bySku(env, 'FLW-GSC-35')]);
    const bdLine = po.items.find((i) => i.product?.id === bd.id)!;
    const ogkLine = po.items.find((i) => i.product?.id === ogk.id)!;

    const input = await hhfPurchase(env, {
      purchase_id: poId,
      notes: undefined,
      expected_delivery_date: undefined,
      lines: [
        { product_id: bd.id, quantity: 144, unit_price: 14 }, // qty 120 → 144
        { product_id: gsc.id, quantity: 24, unit_price: 15.5 }, // new line; OG Kush dropped
      ],
    });
    const update = await env.harness.propose({ ctx: env.ctx, principal: planner, ops: [{ action: ACTION, input }] });
    const op = update.ops[0]!;
    expect(op.summary).toBe(`Update ${po.purchase_number} (Humboldt Heritage Farms): 2 lines, 168 units, $2,388`);
    const changes = op.diff.map((c) => `${c.kind} ${formatPath(c.path)}`);
    expect(changes).toEqual([`changed items[id=${bdLine.id}].quantity`, 'added items[new:1]', `removed items[id=${ogkLine.id}]`]);
    expect(op.diff[0]).toMatchObject({ before: 120, after: 144 });
    expect(op.diff[1]?.after).toMatchObject({ product_id: gsc.id, quantity: 24, price: 15.5 });
    expect(op.payload).toMatchObject({ id: poId });
    expect(op.payload).not.toHaveProperty('description');

    await env.harness.decide({ ctx: env.ctx, principal: approver, proposalId: update.id, decision: 'approve' });
    const done = await env.harness.execute({ ctx: env.ctx, proposalId: update.id });
    expect(done.status).toBe('executed');
    expect(done.ops[0]!.result).toMatchObject({ recordId: poId, deduplicated: false, mismatches: [] });
    const after = (await env.ctx.connectors.distru.getPurchase(poId)).data!;
    expect(after.items.map((i) => [i.product?.sku, Number(i.quantity)]).sort()).toEqual([
      ['FLW-BD-35', 144],
      ['FLW-GSC-35', 24],
    ]);
    // both writes' markers are on the PO; the original notes survive the update
    expect(after.description).toContain('Weekly restock');
    expect(after.description).toContain(op.idempotencyKey);
    expect(env.net.purchaseWrites).toBe(2);
  });

  test('update is refused for completed POs, other vendors and unknown ids', async () => {
    const history = z
      .object({ purchases: z.array(z.object({ id: z.string(), status: z.string() })) })
      .parse(await env.read('vendor_purchase_history', { vendor_id: (await bySku(env, 'FLW-BD-35')).vendor!.id, statuses: ['COMPLETED'], limit: 1 }));
    const completed = history.purchases[0]!;
    const propose = async (extra: Partial<PurchaseUpsertInput>) =>
      env.harness.propose({ ctx: env.ctx, principal: planner, ops: [{ action: ACTION, input: await hhfPurchase(env, extra) }] });
    await expect(propose({ purchase_id: completed.id })).rejects.toThrow('can no longer be edited');
    await expect(propose({ purchase_id: 'nope' })).rejects.toThrow('not found');
    const state = await env.mockState();
    const other = state.vendors.find((v) => v.name === 'Sierra Extracts Co.')!;
    const created = await env.harness.execute({ ctx: env.ctx, proposalId: (await proposeAndApprove(env, await hhfPurchase(env))).id });
    await expect(propose({ purchase_id: created.ops[0]!.result!.recordId!, vendor_id: other.id })).rejects.toThrow('another vendor');
    await expect(propose({ lines: [{ product_id: 'a', quantity: 1, unit_price: 1 }, { product_id: 'a', quantity: 2, unit_price: 1 }] })).rejects.toThrow(
      'only one line',
    );
  });
});
