/** `distru.tasks.create` through the harness against the in-process Distru mock: PO → hand-off task. */
import { beforeEach, describe, expect, test } from 'bun:test';
import { DistruApiError } from '@ops/distru-client';
import { opRef, type Proposal } from '@ops/harness';
import { z } from 'zod';
import { TaskCreateInputSchema, type PurchaseUpsertInput } from '../src';
import { ProductDetailSchema } from '../src/tools/catalog';
import { approver, planner, setup, type Env } from './setup';

const PO = 'distru.purchases.upsert';
const TASK = 'distru.tasks.create';

async function poInput(env: Env): Promise<PurchaseUpsertInput> {
  const bd = ProductDetailSchema.parse(await env.read('products_get', { sku: 'FLW-BD-35' }));
  const state = await env.mockState();
  return { vendor_id: bd.vendor!.id, location_id: state.locations[0]!.id, lines: [{ product_id: bd.id, quantity: 120, unit_price: 14 }], notes: 'Weekly restock' };
}

const taskInput = () => ({
  name: `Receive ${opRef(0, 'purchase_number')} on 2026-12-03`,
  due: '2026-12-03',
  owner_role: 'Purchasing Manager',
  purchase_id: opRef(0, 'recordId'),
  description: 'Check the delivery against the PO and receive it in Distru.',
});

const TaskState = z.object({ counts: z.object({ tasks: z.number() }) });
const taskCount = async (env: Env) => TaskState.parse(await (await env.mock.app.request('/__mock/state')).json()).counts.tasks;

async function approved(env: Env): Promise<Proposal> {
  const po = await poInput(env);
  const p = await env.harness.propose({ ctx: env.ctx, principal: planner, ops: [{ action: PO, input: po }, { action: TASK, input: taskInput() }] });
  return env.harness.decide({ ctx: env.ctx, principal: approver, proposalId: p.id, decision: 'approve' });
}

describe('tasks.create through the harness', () => {
  let env: Env;
  beforeEach(() => {
    env = setup();
  });

  test('propose: low risk, owner resolved from the role via /users, placeholders kept in payload and diff', async () => {
    const seeded = await taskCount(env);
    const po = await poInput(env);
    const p = await env.harness.propose({ ctx: env.ctx, principal: planner, ops: [{ action: PO, input: po }, { action: TASK, input: taskInput() }] });
    const task = p.ops[1]!;
    expect(task.risk).toBe('low');
    expect(task.value).toBe(0); // moneyless
    const users = await env.ctx.connectors.distru.listUsers({});
    const sam = users.data!.find((u) => u.role?.name === 'Purchasing Manager')!;
    expect(task.payload).toEqual({
      name: 'Receive {{op:0.purchase_number}} on 2026-12-03',
      status: 'ACTIVE',
      due_datetime: '2026-12-03T17:00:00Z',
      description: 'Check the delivery against the PO and receive it in Distru.',
      owner_id: sam.id,
      purchase_id: '{{op:0.recordId}}',
      location_id: null,
    });
    expect(task.summary).toBe('Task "Receive {{op:0.purchase_number}} on 2026-12-03" → Sam Rivera, due 2026-12-03');
    expect(task.diff.find((c) => c.path[0] === 'purchase_id')?.after).toBe('{{op:0.recordId}}');
    expect(await taskCount(env)).toBe(seeded); // proposing never writes
  });

  test('execute: PO first, then the task linked to it with the real PO number; verified; re-execute writes nothing', async () => {
    const before = await taskCount(env);
    const p = await approved(env);
    const done = await env.harness.execute({ ctx: env.ctx, proposalId: p.id });
    expect(done.status).toBe('executed');
    const [poOp, taskOp] = done.ops;
    const poNumber = poOp!.result!.outputs!.purchase_number;
    expect(typeof poNumber).toBe('string');
    expect(taskOp!.result).toMatchObject({ error: null, mismatches: [], resolved: { '{{op:0.purchase_number}}': poNumber, '{{op:0.recordId}}': poOp!.result!.recordId } });
    expect(env.audit.types(p.id).filter((t) => t === 'op.verified')).toHaveLength(2);

    const task = (await env.ctx.connectors.distru.getTask(taskOp!.result!.recordId!)).data!;
    expect(task.name).toBe(`Receive ${String(poNumber)} on 2026-12-03`);
    expect(task.purchase).toMatchObject({ id: poOp!.result!.recordId, purchase_number: poNumber });
    expect(task.owner?.full_name).toBe('Sam Rivera');
    expect(task.description).toContain(`[ops-agent:idem=${taskOp!.idempotencyKey}]`);
    expect(await taskCount(env)).toBe(before + 1);

    await env.harness.execute({ ctx: env.ctx, proposalId: p.id });
    expect(await taskCount(env)).toBe(before + 1);
    expect(env.net.purchaseWrites).toBe(1);
  });

  test('crash after the task write landed: the resume finds it by idempotency key (no duplicate task)', async () => {
    const p = await approved(env);
    const before = await taskCount(env);
    // The task POST lands, then the client sees a gateway timeout.
    const realUpsert = env.ctx.connectors.distru.upsertTask;
    let crashed = false;
    env.ctx.connectors.distru.upsertTask = async (...args: Parameters<typeof realUpsert>) => {
      const res = await realUpsert(...args);
      if (!crashed) {
        crashed = true;
        throw new DistruApiError(503, [{ message: 'upstream timeout', pointer: ['base'] }], 'POST', 'http://mock.test/public/v1/tasks');
      }
      return res;
    };
    const done = await env.harness.execute({ ctx: env.ctx, proposalId: p.id });
    expect(done.status).toBe('executed');
    expect(done.ops[1]!.result).toMatchObject({ deduplicated: true, attempts: 2 });
    expect(await taskCount(env)).toBe(before + 1);
  });

  test('verify catches a task changed behind our back', async () => {
    const p = await approved(env);
    const realGet = env.ctx.connectors.distru.getTask;
    env.ctx.connectors.distru.getTask = async (...args: Parameters<typeof realGet>) => {
      const res = await realGet(...args);
      return res.data ? { ...res, data: { ...res.data, name: 'Something else' } } : res;
    };
    const done = await env.harness.execute({ ctx: env.ctx, proposalId: p.id });
    expect(done.status).toBe('failed');
    expect(done.ops[1]!.result?.mismatches[0]).toMatchObject({ path: ['name'], actual: 'Something else' });
  });

  test('input validation: single-line name, owner_id xor owner_role, unknown role refused at plan time', async () => {
    expect(TaskCreateInputSchema.safeParse({ name: 'a\nb', due: '2026-12-03' }).success).toBe(false);
    expect(TaskCreateInputSchema.safeParse({ name: 'x', due: '2026-12-03', owner_id: 'u', owner_role: 'r' }).success).toBe(false);
    await expect(env.harness.propose({ ctx: env.ctx, principal: planner, ops: [{ action: TASK, input: { name: 'x', due: '2026-12-03', owner_role: 'Astronaut' } }] })).rejects.toThrow('No active Distru user with role "Astronaut"');
  });
});
