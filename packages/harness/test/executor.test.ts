import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  defineAction,
  Registry,
  ForbiddenError,
  isResumable,
  NotResumableError,
  AuditEventSchema,
  Budget,
  InMemoryProposalStore,
  MemoStepRunner,
  RULE_KEYS,
  stepIds,
  type Proposal,
} from '../src';
import { agent, approvedProposal, approver, HttpError, operator, poInput, purchaseUpsertAction, setup, type Ctx } from './fixtures';

/** A store that "crashes the process" the first time an op result is persisted. */
class CrashOnOpSaveStore extends InMemoryProposalStore {
  armed = true;
  override async compareAndSet(next: Proposal, expectedVersion: number): Promise<boolean> {
    if (this.armed && next.ops.some((op) => op.result !== null)) {
      this.armed = false;
      throw new Error('process crashed');
    }
    return super.compareAndSet(next, expectedVersion);
  }
}

describe('executeProposal', () => {
  test('happy path: writes, verifies, marks executed, and records results', async () => {
    const env = setup();
    const p = await approvedProposal(env);
    const done = await env.harness.execute({ ctx: env.ctx, proposalId: p.id });

    expect(done.status).toBe('executed');
    expect(env.erp.writes).toBe(1);
    const [op] = done.ops;
    expect(op?.status).toBe('executed');
    expect(op?.result).toMatchObject({ deduplicated: false, attempts: 1, mismatches: [], error: null });
    const record = env.erp.get(op?.result?.recordId ?? '');
    expect(record?.externalRef).toBe(op?.idempotencyKey ?? '');
    expect(done.execution).toMatchObject({ error: null });
  });

  test('re-running an executed proposal performs zero writes', async () => {
    const env = setup();
    const p = await approvedProposal(env, [poInput(), poInput({ vendorId: 'v-2' })]);
    await env.harness.execute({ ctx: env.ctx, proposalId: p.id });
    expect(env.erp.writes).toBe(2);
    const again = await env.harness.execute({ ctx: env.ctx, proposalId: p.id });
    expect(again.status).toBe('executed');
    expect(env.erp.writes).toBe(2);
    expect(env.audit.ofType('op.executed')).toHaveLength(2);
  });

  test('crash after the write but before marking the op executed is deduplicated on retry', async () => {
    const store = new CrashOnOpSaveStore();
    const steps = new MemoStepRunner();
    const env = setup({ store, steps });
    const p = await approvedProposal(env);

    await expect(env.harness.execute({ ctx: env.ctx, proposalId: p.id })).rejects.toThrow('process crashed');
    expect(env.erp.writes).toBe(1);
    const mid = await env.harness.get(p.id);
    expect(mid.status).toBe('executing');
    expect(mid.ops[0]?.status).toBe('pending');

    // The durable runner retries the function: the start step is memoized, the op step re-runs.
    const done = await env.harness.execute({ ctx: env.ctx, proposalId: p.id });
    expect(done.status).toBe('executed');
    expect(env.erp.writes).toBe(1);
    expect(done.ops[0]?.result?.deduplicated).toBe(true);
    expect(env.audit.types(p.id)).toContain('op.deduplicated');
    expect(steps.calls.filter((id) => id === stepIds.op(p.id, 0))).toHaveLength(2);
  });

  test('memoized steps are not re-run on replay', async () => {
    const steps = new MemoStepRunner();
    const env = setup({ steps });
    const p = await approvedProposal(env);
    await env.harness.execute({ ctx: env.ctx, proposalId: p.id });
    const events = env.audit.events.length;
    await env.harness.execute({ ctx: env.ctx, proposalId: p.id });
    expect(env.erp.writes).toBe(1);
    expect(env.audit.events.length).toBe(events);
  });

  test('retries retryable errors, honouring Retry-After, then exponential backoff with jitter', async () => {
    const env = setup();
    const p = await approvedProposal(env);
    env.erp.failures = [new HttpError(429, 1500), new HttpError(503)];
    const done = await env.harness.execute({ ctx: env.ctx, proposalId: p.id });

    expect(done.status).toBe('executed');
    expect(done.ops[0]?.result?.attempts).toBe(3);
    // attempt 1 → Retry-After 1500ms; attempt 2 → random(0.5) × min(10s, 250 × 2^1) = 250ms
    expect(env.clock.sleeps).toEqual([1500, 250]);
    expect(env.audit.ofType('op.retry').map((e) => [e.data.attempt, e.data.delayMs])).toEqual([[1, 1500], [2, 250]]);
    expect(env.erp.writes).toBe(1);
  });

  test('gives up after maxAttempts and marks the proposal failed', async () => {
    const env = setup({ config: { retry: { maxAttempts: 3 } } });
    const p = await approvedProposal(env);
    env.erp.failures = [new HttpError(503), new HttpError(503), new HttpError(503)];
    const done = await env.harness.execute({ ctx: env.ctx, proposalId: p.id });
    expect(done.status).toBe('failed');
    expect(done.ops[0]?.result).toMatchObject({ attempts: 3, error: { message: 'HTTP 503', code: 'retries_exhausted' } });
  });

  test('stops on the first non-retryable failure with partial results, then resumes safely', async () => {
    const env = setup();
    const p = await approvedProposal(env, [poInput(), poInput({ vendorId: 'v-2' }), poInput({ vendorId: 'v-3' })]);
    env.erp.failures = [];
    // op 0 succeeds; op 1 fails with a 400; op 2 must not run
    const origUpsert = env.erp.upsert.bind(env.erp);
    let calls = 0;
    env.erp.upsert = (payload, key) => {
      calls++;
      if (calls === 2) throw new HttpError(400);
      return origUpsert(payload, key);
    };
    const failed = await env.harness.execute({ ctx: env.ctx, proposalId: p.id });
    expect(failed.status).toBe('failed');
    expect(failed.ops.map((o) => o.status)).toEqual(['executed', 'failed', 'pending']);
    expect(failed.ops[1]?.result?.attempts).toBe(1);
    expect(failed.execution?.error?.message).toBe('HTTP 400');
    expect(env.audit.ofType('proposal.failed')[0]?.data.failedOpIndex).toBe(1);

    // fix the cause and resume: op 0 is skipped, ops 1 and 2 are written
    env.erp.upsert = origUpsert;
    const writesBefore = env.erp.writes;
    const resumed = await env.harness.execute({ ctx: env.ctx, proposalId: p.id });
    expect(resumed.status).toBe('executed');
    expect(resumed.ops.map((o) => o.status)).toEqual(['executed', 'executed', 'executed']);
    expect(env.erp.writes - writesBefore).toBe(2);
    expect(env.audit.ofType('proposal.execution_started').map((e) => e.data.resumed)).toEqual([false, true]);
  });

  test('requestResume: approver only, failed proposals only, audited with the failed op', async () => {
    const env = setup();
    const p = await approvedProposal(env);
    expect(isResumable(p)).toBe(false);
    await expect(env.harness.requestResume({ principal: approver, proposalId: p.id })).rejects.toBeInstanceOf(NotResumableError);
    env.erp.upsert = () => {
      throw new HttpError(400);
    };
    const failed = await env.harness.execute({ ctx: env.ctx, proposalId: p.id });
    expect(isResumable(failed)).toBe(true);
    await expect(env.harness.requestResume({ principal: operator, proposalId: p.id })).rejects.toBeInstanceOf(ForbiddenError);
    await env.harness.requestResume({ principal: approver, proposalId: p.id, reason: 'vendor fixed' });
    expect(env.audit.ofType('proposal.resume_requested').map((e) => e.data)).toEqual([{ reason: 'vendor fixed', failedOpIndex: 0 }]);
  });

  test('verify mismatch → op and proposal failed with mismatches', async () => {
    const env = setup();
    const p = await approvedProposal(env);
    env.erp.corrupt = (record) => {
      const item = record.items[0];
      if (item) item.quantity = 1;
    };
    const done = await env.harness.execute({ ctx: env.ctx, proposalId: p.id });
    expect(done.status).toBe('failed');
    expect(done.ops[0]?.status).toBe('failed');
    expect(done.ops[0]?.result?.error?.name).toBe('VerificationFailed');
    expect(done.ops[0]?.result?.mismatches).toEqual([{ path: ['items', 'new:0'], expected: { productId: 'sku-1', quantity: 10, unitPrice: 5 }, actual: undefined }, { path: ['items', 'id=li-100'], expected: undefined, actual: { id: 'li-100', productId: 'sku-1', quantity: 1, unitPrice: 5 } }]);
    expect(env.audit.ofType('op.verify_failed')).toHaveLength(1);
  });

  test('budget exceeded mid-run stops before the next write and fails the proposal', async () => {
    const env = setup();
    const p = await approvedProposal(env, [poInput(), poInput({ vendorId: 'v-2' })]);
    // op 0: write (1) + verify (2); op 1: write (3) > 2 → exceeded before writing
    const budget = new Budget({ maxSteps: 2 }, env.clock);
    const done = await env.harness.execute({ ctx: env.ctx, proposalId: p.id, budget });
    expect(done.status).toBe('failed');
    expect(env.erp.writes).toBe(1);
    expect(done.ops.map((o) => o.status)).toEqual(['executed', 'pending']);
    expect(done.execution?.error?.name).toBe('BudgetExceededError');
    expect(env.audit.ofType('budget.exceeded')[0]?.data).toEqual({ dimension: 'steps', limit: 2, used: 3 });
  });

  test('cancellation via AbortSignal stops execution', async () => {
    const env = setup();
    const p = await approvedProposal(env);
    const controller = new AbortController();
    controller.abort();
    const done = await env.harness.execute({ ctx: env.ctx, proposalId: p.id, signal: controller.signal });
    expect(done.status).toBe('failed');
    expect(done.execution?.error?.name).toBe('CancelledError');
    expect(env.erp.writes).toBe(0);
  });

  test('auto-approved proposals execute without a human decision', async () => {
    const env = setup({ rules: [{ key: RULE_KEYS.autoApproveBelow, params: { maxValue: 100 } }] });
    const p = await env.harness.propose({ ctx: env.ctx, principal: agent, ops: [{ action: 'purchases.upsert', input: poInput() }] });
    expect(p.status).toBe('auto_approved');
    expect((await env.harness.execute({ ctx: env.ctx, proposalId: p.id })).status).toBe('executed');
  });
});

describe('audit trail', () => {
  test('full happy path: ordered, attributed, timestamped, schema-valid', async () => {
    const env = setup();
    const p = await env.harness.propose({ ctx: env.ctx, principal: agent, ops: [{ action: 'purchases.upsert', input: poInput() }] });
    env.clock.advance(60_000);
    await env.harness.decide({ ctx: env.ctx, principal: approver, proposalId: p.id, decision: 'approve', reason: 'lgtm' });
    env.clock.advance(1_000);
    await env.harness.execute({ ctx: env.ctx, proposalId: p.id });

    const events = env.audit.forProposal(p.id);
    expect(events.map((e) => e.type)).toEqual([
      'proposal.created',
      'policy.evaluated',
      'proposal.decided',
      'proposal.execution_started',
      'op.executed',
      'op.verified',
      'proposal.executed',
    ]);
    for (const e of events) expect(AuditEventSchema.parse(e)).toEqual(e);
    expect(events.map((e) => e.actor.kind)).toEqual(['agent', 'agent', 'user', 'system', 'system', 'system', 'system']);
    expect(events.map((e) => e.at)).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:01:00.000Z',
      '2026-01-01T00:01:01.000Z',
      '2026-01-01T00:01:01.000Z',
      '2026-01-01T00:01:01.000Z',
      '2026-01-01T00:01:01.000Z',
    ]);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);

    const created = env.audit.ofType('proposal.created')[0];
    expect(created?.data).toEqual({ opCount: 1, actions: ['purchases.upsert'], totalValue: 50 });
    expect(env.audit.ofType('proposal.decided')[0]?.data).toEqual({ decision: 'approve', reason: 'lgtm', edited: false });
    const executed = env.audit.ofType('op.executed')[0];
    expect(executed?.data).toMatchObject({ opIndex: 0, action: 'purchases.upsert', attempts: 1, idempotencyKey: p.ops[0]?.idempotencyKey ?? '' });
  });
});

/**
 * A delta write with no idempotency lookup (like Distru's inventory adjustment through the MCP bridge):
 * the ERP saves it, then a downstream sync (Metrc) may fail, which only the read-after-write check sees.
 */
function adjustEnv() {
  const adjustments: Array<{ id: string; delta: number; synced: boolean }> = [];
  let syncFails = true;
  const adjust = defineAction({
    name: 'stock.adjust',
    resource: 'stock',
    description: 'Adjust stock by a signed delta (synced to the state system in the background).',
    risk: 'low',
    input: z.object({ delta: z.number() }),
    loadBefore: async () => null,
    plan: (_ctx: Ctx, input) => ({ delta: input.delta }),
    execute: async (_ctx: Ctx, payload) => {
      const record = { id: `adj-${adjustments.length + 1}`, delta: payload.delta, synced: !syncFails };
      adjustments.push(record);
      return { recordId: record.id, record };
    },
    findByIdempotencyKey: async () => null,
    verify: async (_ctx: Ctx, recordId) => {
      const a = adjustments.find((x) => x.id === recordId);
      return a?.synced ? { ok: true, mismatches: [] } : { ok: false, mismatches: [{ path: ['sync', 'status'], expected: 'COMPLETED', actual: 'FAILED' }] };
    },
    valueOf: () => 0,
  });
  const env = setup({ config: { registry: new Registry<Ctx>({ actions: [purchaseUpsertAction(), adjust] }) } });
  return {
    env,
    adjustments,
    syncNow: () => {
      syncFails = false;
      for (const a of adjustments) a.synced = true;
    },
  };
}

describe('write saved, downstream sync failed', () => {
  test('earlier ops stay executed; a resume re-verifies the saved record and never writes it again', async () => {
    const { env, adjustments, syncNow } = adjustEnv();
    const proposal = await env.harness.propose({
      ctx: env.ctx,
      principal: agent,
      ops: [
        { action: 'purchases.upsert', input: poInput() },
        { action: 'stock.adjust', input: { delta: -2 } },
        { action: 'purchases.upsert', input: poInput({ vendorId: 'v-2' }) },
      ],
    });
    const p = await env.harness.decide({ ctx: env.ctx, principal: approver, proposalId: proposal.id, decision: 'approve' });

    const failed = await env.harness.execute({ ctx: env.ctx, proposalId: p.id });
    expect(failed.status).toBe('failed');
    expect(failed.ops.map((o) => o.status)).toEqual(['executed', 'failed', 'pending']);
    expect(failed.ops[1]?.result).toMatchObject({ recordId: 'adj-1', deduplicated: false, error: { name: 'VerificationFailed' } });
    expect(failed.ops[1]?.result?.mismatches).toEqual([{ path: ['sync', 'status'], expected: 'COMPLETED', actual: 'FAILED' }]);
    expect(adjustments).toHaveLength(1);
    expect(env.audit.ofType('op.verify_failed').map((e) => e.data.recordId)).toEqual(['adj-1']);

    // Resume while the sync is still failing: no second adjustment, still failed with the detail.
    const stillFailed = await env.harness.execute({ ctx: env.ctx, proposalId: p.id });
    expect(stillFailed.status).toBe('failed');
    expect(adjustments).toHaveLength(1);
    expect(stillFailed.ops[1]?.result).toMatchObject({ recordId: 'adj-1', deduplicated: true, error: { name: 'VerificationFailed' } });
    expect(env.audit.ofType('op.deduplicated').map((e) => e.data)).toEqual([expect.objectContaining({ opIndex: 1, recordId: 'adj-1', dedupedBy: 'executor_record' })]);

    // The sync is retried on the ERP side: the resume verifies the same record and finishes the rest.
    syncNow();
    const writesBefore = env.erp.writes;
    const done = await env.harness.execute({ ctx: env.ctx, proposalId: p.id });
    expect(done.status).toBe('executed');
    expect(done.ops.map((o) => o.status)).toEqual(['executed', 'executed', 'executed']);
    expect(adjustments).toHaveLength(1);
    expect(env.erp.writes - writesBefore).toBe(1); // only op 2; op 0 was never rewritten
  });
});

describe('infrastructure failures', () => {
  test('an audit sink failure during an op is not recorded as an op failure; the run resumes cleanly', async () => {
    const env = setup();
    const p = await approvedProposal(env);
    const append = env.audit.append.bind(env.audit);
    let failOnce = true;
    env.audit.append = async (event) => {
      if (failOnce && event.type === 'op.executed') {
        failOnce = false;
        throw new Error('audit db down');
      }
      return append(event);
    };
    await expect(env.harness.execute({ ctx: env.ctx, proposalId: p.id })).rejects.toThrow('Audit sink failed');
    expect((await env.harness.get(p.id)).ops[0]?.status).toBe('pending');
    const done = await env.harness.execute({ ctx: env.ctx, proposalId: p.id });
    expect(done.status).toBe('executed');
    expect(env.erp.writes).toBe(1);
    expect(done.ops[0]?.result?.deduplicated).toBe(true);
  });
});
