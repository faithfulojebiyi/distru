/** Undo of Distru writes through the harness against the in-process mock: PO delete / restore, task delete. */
import { describe, expect, test } from 'bun:test';
import { DistruApiError } from '@ops/distru-client';
import { opRef, userPrincipal, type Proposal } from '@ops/harness';
import { type PurchaseUpsertInput } from '../src';
import { ProductDetailSchema } from '../src/tools/catalog';
import { approver, planner, setup, type Env } from './setup';

const PO = 'distru.purchases.upsert';
const TASK = 'distru.tasks.create';
const operator = userPrincipal('u-operator', 'operator', 'Olly Operator');
const approver2 = userPrincipal('u-approver-2', 'approver', 'Bea Approver');

async function poInput(env: Env, quantity = 120): Promise<PurchaseUpsertInput> {
  const bd = ProductDetailSchema.parse(await env.read('products_get', { sku: 'FLW-BD-35' }));
  const state = await env.mockState();
  return { vendor_id: bd.vendor!.id, location_id: state.locations[0]!.id, lines: [{ product_id: bd.id, quantity, unit_price: 14 }], notes: 'Weekly restock' };
}

async function run(env: Env, p: Proposal, by = approver): Promise<Proposal> {
  await env.harness.decide({ ctx: env.ctx, principal: by, proposalId: p.id, decision: 'approve' });
  return env.harness.execute({ ctx: env.ctx, proposalId: p.id });
}

const notFound = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return false;
  } catch (err) {
    return err instanceof DistruApiError && err.isNotFound;
  }
};

describe('undo Distru writes', () => {
  test('created PO + linked task → undo proposal (task first, then PO delete) → both gone; re-execute is a no-op', async () => {
    const env = setup();
    const p = await env.harness.propose({
      ctx: env.ctx,
      principal: planner,
      ops: [
        { action: PO, input: await poInput(env) },
        { action: TASK, input: { name: `Receive ${opRef(0, 'purchase_number')}`, due: '2026-12-03', owner_role: 'Purchasing Manager', purchase_id: opRef(0, 'recordId') } },
      ],
    });
    const done = await run(env, p);
    expect(done.status).toBe('executed');
    const poId = done.ops[0]!.result!.recordId!;
    const taskId = done.ops[1]!.result!.recordId!;

    const info = await env.harness.undoInfo(done.id);
    expect(info.ops.map((o) => o.canUndo)).toEqual([true, true]);

    const u = await env.harness.undo({ ctx: env.ctx, principal: operator, proposalId: done.id, reason: 'Vendor out of stock' });
    expect(u.status).toBe('pending_approval');
    expect(u.ops.map((o) => o.action)).toEqual([`${TASK}.undo`, `${PO}.undo`]);
    expect(u.ops[0]!.summary).toMatch(/^Delete task "Receive PO-\d+" \(assigned to Sam Rivera\)$/);
    expect(u.ops[1]!.summary).toMatch(/^Delete PO-\d+ \(PENDING, never received\)/);
    expect(u.ops[1]!.diff[0]).toMatchObject({ path: [], kind: 'removed' });
    expect(u.ops[1]!.value).toBe(0);

    const undone = await run(env, u, approver2);
    expect(undone.status).toBe('executed');
    expect(await notFound(() => env.ctx.connectors.distru.getPurchase(poId))).toBe(true);
    expect(await notFound(() => env.ctx.connectors.distru.getTask(taskId))).toBe(true);
    // Idempotent: executing again (e.g. a replay) changes nothing and does not fail on the 404s.
    expect((await env.harness.execute({ ctx: env.ctx, proposalId: u.id })).status).toBe('executed');
  });

  test('updated PO → undo restores the previous line set (verified by read-back)', async () => {
    const env = setup({ rules: [] });
    const created = await run(env, await env.harness.propose({ ctx: env.ctx, principal: planner, ops: [{ action: PO, input: await poInput(env, 100) }] }));
    const poId = created.ops[0]!.result!.recordId!;
    const update = await run(env, await env.harness.propose({ ctx: env.ctx, principal: planner, ops: [{ action: PO, input: { ...(await poInput(env, 300)), purchase_id: poId, notes: 'More' } }] }));
    expect(update.status).toBe('executed');
    expect(Number((await env.ctx.connectors.distru.getPurchase(poId)).data!.items[0]!.quantity)).toBe(300);

    const u = await env.harness.undo({ ctx: env.ctx, principal: operator, proposalId: update.id, reason: 'Too much' });
    expect(u.ops[0]!.diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ['description'], before: 'More', after: 'Weekly restock' }),
        expect.objectContaining({ path: ['items', expect.stringMatching(/^id=/), 'quantity'], before: 300, after: 100 }),
      ]),
    );
    expect(u.ops[0]!.value).toBe(1400);
    const undone = await run(env, u, approver2);
    expect(undone.status).toBe('executed');
    const po = (await env.ctx.connectors.distru.getPurchase(poId)).data!;
    expect(Number(po.items[0]!.quantity)).toBe(100);
    expect(po.description).toContain('Weekly restock');
    // The idempotency marker already on the PO (the update's) survives the restore.
    expect(po.description).toContain(update.ops[0]!.idempotencyKey);
  });

  test('a PO received meanwhile is not undone automatically', async () => {
    const env = setup({ rules: [] });
    const created = await run(env, await env.harness.propose({ ctx: env.ctx, principal: planner, ops: [{ action: PO, input: await poInput(env, 10) }] }));
    const poId = created.ops[0]!.result!.recordId!;
    // Received in Distru meanwhile (Metrc-matched receipt; set directly on the mock store).
    env.mock.store.purchases.get(poId)!.status = 'COMPLETED';
    await expect(env.harness.undo({ ctx: env.ctx, principal: operator, proposalId: created.id, reason: 'x' })).rejects.toThrow(/COMPLETED: received stock/);
  });
});
