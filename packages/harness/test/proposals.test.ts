import { describe, expect, test } from 'bun:test';
import {
  assertTransition,
  canTransition,
  DecisionConflictError,
  idempotencyKeyFor,
  IllegalTransitionError,
  InputValidationError,
  NotFoundError,
  PolicyDeniedError,
  PROPOSAL_TRANSITIONS,
  ProposalSchema,
  ProposalStatusSchema,
  RULE_KEYS,
  type ProposalStatus,
} from '../src';
import { agent, approvedProposal, approver, approver2, poInput, setup } from './fixtures';

const op = (input: unknown) => ({ action: 'purchases.upsert', input });

describe('status machine', () => {
  const legal: Array<[ProposalStatus, ProposalStatus]> = [
    ['draft', 'pending_approval'],
    ['draft', 'auto_approved'],
    ['draft', 'denied'],
    ['pending_approval', 'approved'],
    ['pending_approval', 'rejected'],
    ['approved', 'executing'],
    ['auto_approved', 'executing'],
    ['executing', 'executed'],
    ['executing', 'failed'],
    ['failed', 'executing'],
  ];

  test('exactly the documented transitions are legal', () => {
    const all = ProposalStatusSchema.options;
    for (const from of all) {
      for (const to of all) {
        const expected = legal.some(([f, t]) => f === from && t === to);
        expect([from, to, canTransition(from, to)]).toEqual([from, to, expected]);
      }
    }
  });

  test('illegal transitions throw a typed error', () => {
    for (const [from, to] of [
      ['pending_approval', 'executing'],
      ['denied', 'approved'],
      ['rejected', 'executing'],
      ['executed', 'executing'],
      ['draft', 'executed'],
    ] as const) {
      expect(() => assertTransition(from, to)).toThrow(IllegalTransitionError);
    }
  });

  test('terminal states have no exits', () => {
    expect(PROPOSAL_TRANSITIONS.executed).toEqual([]);
    expect(PROPOSAL_TRANSITIONS.rejected).toEqual([]);
    expect(PROPOSAL_TRANSITIONS.denied).toEqual([]);
  });

  test('the harness refuses to execute proposals that are not approved', async () => {
    const env = setup();
    const pending = await env.harness.propose({ ctx: env.ctx, principal: agent, ops: [op(poInput())] });
    await expect(env.harness.execute({ ctx: env.ctx, proposalId: pending.id })).rejects.toThrow(IllegalTransitionError);
    await env.harness.decide({ ctx: env.ctx, principal: approver, proposalId: pending.id, decision: 'reject' });
    await expect(env.harness.execute({ ctx: env.ctx, proposalId: pending.id })).rejects.toThrow(IllegalTransitionError);
    expect(env.erp.writes).toBe(0);
  });
});

describe('propose', () => {
  test('builds a validated, planned, diffed changeset and never writes', async () => {
    const env = setup();
    env.erp.seed({ id: 'po-1', vendorId: 'v-acme', status: 'draft', externalRef: null, items: [{ id: 'li-1', productId: 'sku-1', quantity: 5, unitPrice: 5 }] });
    const p = await env.harness.propose({
      ctx: env.ctx,
      principal: agent,
      ops: [op(poInput({ purchaseId: 'po-1', items: [{ id: 'li-1', productId: 'sku-1', quantity: 20, unitPrice: 5 }, { productId: 'sku-2', quantity: 1, unitPrice: 3 }] }))],
      title: 'Restock Blue Dream',
      rationale: '3 days of supply left',
      meta: { runId: 'run-1' },
    });

    expect(env.erp.writes).toBe(0);
    expect(ProposalSchema.parse(p)).toEqual(p);
    expect(p).toMatchObject({ id: 'p-1', version: 1, status: 'pending_approval', title: 'Restock Blue Dream', meta: { runId: 'run-1' } });
    const [first] = p.ops;
    expect(first?.before).toMatchObject({ id: 'po-1' });
    expect(first?.payload).toEqual({ id: 'po-1', vendorId: 'v-acme', items: [{ id: 'li-1', productId: 'sku-1', quantity: 20, unitPrice: 5 }, { productId: 'sku-2', quantity: 1, unitPrice: 3 }] });
    expect(first?.diff).toEqual([
      { path: ['items', 'id=li-1', 'quantity'], kind: 'changed', before: 5, after: 20 },
      { path: ['items', 'new:1'], kind: 'added', before: undefined, after: { productId: 'sku-2', quantity: 1, unitPrice: 3 } },
    ]);
    expect(first?.value).toBe(103);
    expect(first?.vendorIds).toEqual(['v-acme']);
    expect(first?.summary).toBe('PO for 2 line(s) from v-acme');
    expect(await env.store.get(p.id)).toEqual(p);
  });

  test('multi-op proposals get deterministic, distinct idempotency keys', async () => {
    const env = setup();
    const p = await env.harness.propose({ ctx: env.ctx, principal: agent, ops: [op(poInput()), op(poInput({ vendorId: 'v-2' }))] });
    expect(p.ops.map((o) => o.idempotencyKey)).toEqual([await idempotencyKeyFor(p.id, 0), await idempotencyKeyFor(p.id, 1)]);
    expect(p.ops[0]?.idempotencyKey).not.toBe(p.ops[1]?.idempotencyKey);
    expect(p.ops[0]?.idempotencyKey).toMatch(/^opk_[0-9a-f]{32}$/);
  });

  test('policy outcome sets the initial status', async () => {
    const auto = setup({ rules: [{ key: RULE_KEYS.autoApproveBelow, params: { maxValue: 100 } }] });
    expect((await auto.harness.propose({ ctx: auto.ctx, principal: agent, ops: [op(poInput())] })).status).toBe('auto_approved');

    const denied = setup({ rules: [{ key: RULE_KEYS.maxTotalValue, params: { max: 10 } }] });
    const p = await denied.harness.propose({ ctx: denied.ctx, principal: agent, ops: [op(poInput())] });
    expect(p.status).toBe('denied');
    expect(p.policy.reasons[0]?.message).toContain('exceeds cap');
    await expect(denied.harness.decide({ ctx: denied.ctx, principal: approver, proposalId: p.id, decision: 'approve' })).rejects.toThrow(DecisionConflictError);
  });

  test('rejects invalid input, unknown actions and empty proposals', async () => {
    const env = setup();
    await expect(env.harness.propose({ ctx: env.ctx, principal: agent, ops: [op({ vendorId: 'v', items: [] })] })).rejects.toThrow(InputValidationError);
    await expect(env.harness.propose({ ctx: env.ctx, principal: agent, ops: [{ action: 'invoices.void', input: {} }] })).rejects.toThrow(NotFoundError);
    await expect(env.harness.propose({ ctx: env.ctx, principal: agent, ops: [] })).rejects.toThrow(InputValidationError);
  });
});

describe('decide', () => {
  test('exactly once under concurrency: one decision wins, the other gets a conflict', async () => {
    const env = setup();
    const p = await env.harness.propose({ ctx: env.ctx, principal: agent, ops: [op(poInput())] });
    const results = await Promise.allSettled([
      env.harness.decide({ ctx: env.ctx, principal: approver, proposalId: p.id, decision: 'approve' }),
      env.harness.decide({ ctx: env.ctx, principal: approver2, proposalId: p.id, decision: 'reject' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(DecisionConflictError);
    expect(env.audit.ofType('proposal.decided')).toHaveLength(1);
    expect((await env.harness.get(p.id)).version).toBe(2);
  });

  test('edits re-plan, re-diff and re-run policy; the idempotency key is stable', async () => {
    const env = setup({ rules: [{ key: RULE_KEYS.maxTotalValue, params: { max: 1000 } }] });
    const p = await env.harness.propose({ ctx: env.ctx, principal: agent, ops: [op(poInput())] });
    const decided = await env.harness.decide({
      ctx: env.ctx,
      principal: approver,
      proposalId: p.id,
      decision: 'approve',
      reason: 'bumped quantity',
      edits: [{ opIndex: 0, input: poInput({ items: [{ productId: 'sku-1', quantity: 40, unitPrice: 5 }] }) }],
    });
    expect(decided.status).toBe('approved');
    expect(decided.decision).toMatchObject({ edited: true, reason: 'bumped quantity' });
    expect(decided.ops[0]?.value).toBe(200);
    expect(decided.ops[0]?.diff).toContainEqual({ path: ['items'], kind: 'added', before: undefined, after: [{ productId: 'sku-1', quantity: 40, unitPrice: 5 }] });
    expect(decided.ops[0]?.idempotencyKey).toBe(p.ops[0]?.idempotencyKey ?? '');
    expect(env.audit.ofType('policy.evaluated').map((e) => e.data.trigger)).toEqual(['propose', 'edit']);
  });

  test('a deny after edits blocks approval and leaves the proposal pending', async () => {
    const env = setup({ rules: [{ key: RULE_KEYS.maxTotalValue, params: { max: 1000 } }] });
    const p = await env.harness.propose({ ctx: env.ctx, principal: agent, ops: [op(poInput())] });
    const attempt = env.harness.decide({
      ctx: env.ctx,
      principal: approver,
      proposalId: p.id,
      decision: 'approve',
      edits: [{ opIndex: 0, input: poInput({ items: [{ productId: 'sku-1', quantity: 1000, unitPrice: 5 }] }) }],
    });
    await expect(attempt).rejects.toThrow(PolicyDeniedError);
    const after = await env.harness.get(p.id);
    expect(after.status).toBe('pending_approval');
    expect(after.ops[0]?.value).toBe(50);
    expect(env.audit.ofType('proposal.decision_blocked')).toHaveLength(1);
  });

  test('edits are approve-only and must target existing ops', async () => {
    const env = setup();
    const p = await env.harness.propose({ ctx: env.ctx, principal: agent, ops: [op(poInput())] });
    await expect(env.harness.decide({ ctx: env.ctx, principal: approver, proposalId: p.id, decision: 'reject', edits: [{ opIndex: 0, input: poInput() }] })).rejects.toThrow(InputValidationError);
    await expect(env.harness.decide({ ctx: env.ctx, principal: approver, proposalId: p.id, decision: 'approve', edits: [{ opIndex: 3, input: poInput() }] })).rejects.toThrow(InputValidationError);
  });

  test('decide on an unknown proposal is NotFound', async () => {
    const env = setup();
    await expect(env.harness.decide({ ctx: env.ctx, principal: approver, proposalId: 'nope', decision: 'approve' })).rejects.toThrow(NotFoundError);
  });

  test('approvedProposal helper sanity', async () => {
    const env = setup();
    expect((await approvedProposal(env)).status).toBe('approved');
  });
});
