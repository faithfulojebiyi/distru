import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  AuditEventSchema,
  createHarness,
  defineAction,
  defineConnector,
  findOpRefs,
  InMemoryAuditSink,
  InMemoryProposalStore,
  InputValidationError,
  opRef,
  Registry,
  resolveOpRefs,
  routeErrorClassifier,
  sequentialIds,
  StaticPolicyRules,
  UnresolvedReferenceError,
  FakeClock,
  type ErrorClassifier,
  type ErrorContext,
} from '../src';
import { agent, approver, FakeErp, HttpError, purchaseUpsertAction, type Ctx } from './fixtures';

/** A "notify" action whose message references the PO number written by an earlier op. */
interface Sent {
  id: string;
  to: string;
  text: string;
  po: string;
  key: string;
}
class Outbox {
  readonly sent: Sent[] = [];
  /** The next send throws (non-retryable) before anything is sent. */
  failNext = false;
}
interface NotifyCtx extends Ctx {
  outbox: Outbox;
}

const NotifyInput = z.object({ to: z.string(), text: z.string(), po: z.string() });
const notifyAction = defineAction({
  name: 'notify.send',
  resource: 'messages',
  description: 'Send a message',
  risk: 'high',
  input: NotifyInput,
  payload: NotifyInput,
  loadBefore: async () => null,
  plan: (_ctx: NotifyCtx, input) => input,
  execute: async (ctx: NotifyCtx, payload, key) => {
    if (ctx.outbox.failNext) {
      ctx.outbox.failNext = false;
      throw new Error('mail server said no');
    }
    const msg = { id: `m-${ctx.outbox.sent.length + 1}`, ...payload, key };
    ctx.outbox.sent.push(msg);
    return { recordId: msg.id, record: msg };
  },
  findByIdempotencyKey: async (ctx: NotifyCtx, key) => {
    const m = ctx.outbox.sent.find((x) => x.key === key);
    return m ? { recordId: m.id, record: m } : null;
  },
  verify: async (ctx: NotifyCtx, recordId, expected) => {
    const m = ctx.outbox.sent.find((x) => x.id === recordId);
    return m && m.text === expected.text && m.po === expected.po ? { ok: true, mismatches: [] } : { ok: false, mismatches: [{ path: ['text'], expected: expected.text, actual: m?.text ?? null }] };
  },
  valueOf: undefined,
});

/** purchases.upsert from the fixtures plus an `outputs` hook exporting a PO number. */
function poWithOutputs() {
  const base = purchaseUpsertAction('low');
  return defineAction({ ...base, outputs: (record) => ({ po_number: `PO-${record.id.replace('po-', '')}`, vendor: record.vendorId }) });
}

function env() {
  const erp = new FakeErp();
  const outbox = new Outbox();
  const store = new InMemoryProposalStore();
  const audit = new InMemoryAuditSink();
  const registry = new Registry<NotifyCtx>({ actions: [poWithOutputs(), notifyAction] });
  const harness = createHarness<NotifyCtx>({ registry, store, audit, clock: new FakeClock(), policyRules: new StaticPolicyRules([]), ids: sequentialIds('p'), random: () => 0.5 });
  return { erp, outbox, store, audit, harness, ctx: { erp, outbox } };
}

const po = { vendorId: 'v-acme', items: [{ productId: 'sku-1', quantity: 10, unitPrice: 5 }] };
const note = (index: number) => ({ to: 'orders@acme.example', text: `Please confirm ${opRef(index, 'po_number')} (id ${opRef(index, 'recordId')}).`, po: opRef(index, 'po_number') });

describe('op references', () => {
  test('findOpRefs / resolveOpRefs: deep, deduplicated, whole-string placeholders keep the value type', () => {
    const value = { a: 'x {{op:0.po_number}} y {{op:0.po_number}}', b: ['{{op:1.recordId}}'], c: { n: '{{op:0.count}}' } };
    expect(findOpRefs(value).map((r) => r.token)).toEqual(['{{op:0.po_number}}', '{{op:1.recordId}}', '{{op:0.count}}']);
    const ops = [
      { index: 0, status: 'executed', result: { recordId: 'po-1', outputs: { po_number: 'PO-1', count: 3 } } },
      { index: 1, status: 'executed', result: { recordId: 'po-2' } },
    ];
    const out = resolveOpRefs(value, ops);
    expect(out.value as unknown).toEqual({ a: 'x PO-1 y PO-1', b: ['po-2'], c: { n: 3 } });
    expect(out.resolved).toEqual({ '{{op:0.po_number}}': 'PO-1', '{{op:1.recordId}}': 'po-2', '{{op:0.count}}': 3 });
    expect(() => resolveOpRefs({ t: '{{op:0.missing}}' }, ops)).toThrow(UnresolvedReferenceError);
    expect(() => resolveOpRefs({ t: '{{op:0.po_number}}' }, [{ index: 0, status: 'pending', result: null }])).toThrow('has not been executed');
    expect(resolveOpRefs({ t: 'no refs' }, [])).toEqual({ value: { t: 'no refs' }, resolved: {} });
  });

  test('propose keeps the placeholder in payload and diff; forward/self references are refused', async () => {
    const e = env();
    const p = await e.harness.propose({ ctx: e.ctx, principal: agent, ops: [{ action: 'purchases.upsert', input: po }, { action: 'notify.send', input: note(0) }] });
    expect(p.ops[1]!.payload).toMatchObject({ po: '{{op:0.po_number}}' });
    expect(p.ops[1]!.diff.find((c) => c.path[0] === 'po')?.after).toBe('{{op:0.po_number}}');

    await expect(e.harness.propose({ ctx: e.ctx, principal: agent, ops: [{ action: 'notify.send', input: note(0) }, { action: 'purchases.upsert', input: po }] })).rejects.toBeInstanceOf(InputValidationError);
    await expect(e.harness.propose({ ctx: e.ctx, principal: agent, ops: [{ action: 'purchases.upsert', input: po }, { action: 'notify.send', input: note(5) }] })).rejects.toThrow('may only reference an earlier op');
  });

  test('execute resolves from the earlier op result, records outputs + resolved values, verifies the resolved payload; re-run writes nothing', async () => {
    const e = env();
    const p = await e.harness.propose({ ctx: e.ctx, principal: agent, ops: [{ action: 'purchases.upsert', input: po }, { action: 'notify.send', input: note(0) }] });
    await e.harness.decide({ ctx: e.ctx, principal: approver, proposalId: p.id, decision: 'approve' });
    const done = await e.harness.execute({ ctx: e.ctx, proposalId: p.id });
    expect(done.status).toBe('executed');

    const [poOp, mailOp] = done.ops;
    expect(poOp!.result?.outputs).toEqual({ po_number: 'PO-101', vendor: 'v-acme' });
    expect(e.outbox.sent).toHaveLength(1);
    expect(e.outbox.sent[0]).toMatchObject({ text: 'Please confirm PO-101 (id po-101).', po: 'PO-101' });
    expect(mailOp!.result?.resolved).toEqual({ '{{op:0.po_number}}': 'PO-101', '{{op:0.recordId}}': 'po-101' });
    // The stored payload is unchanged (honest diff); only the result records the substitution.
    expect(mailOp!.payload).toMatchObject({ po: '{{op:0.po_number}}' });
    const executed = e.audit.ofType('op.executed').map((ev) => AuditEventSchema.parse(ev));
    expect(executed[1]!.data).toMatchObject({ resolved: { '{{op:0.po_number}}': 'PO-101' } });

    await e.harness.execute({ ctx: e.ctx, proposalId: p.id });
    expect(e.outbox.sent).toHaveLength(1);
    expect(e.erp.writes).toBe(1);
  });

  test('resuming after a failure resolves from the persisted result of the earlier op', async () => {
    const e = env();
    const p = await e.harness.propose({ ctx: e.ctx, principal: agent, ops: [{ action: 'purchases.upsert', input: po }, { action: 'notify.send', input: note(0) }] });
    await e.harness.decide({ ctx: e.ctx, principal: approver, proposalId: p.id, decision: 'approve' });
    e.outbox.failNext = true;
    const failed = await e.harness.execute({ ctx: e.ctx, proposalId: p.id });
    expect(failed.status).toBe('failed');
    expect(failed.ops.map((o) => o.status)).toEqual(['executed', 'failed']);
    expect(failed.ops[1]!.result?.resolved).toEqual({ '{{op:0.po_number}}': 'PO-101', '{{op:0.recordId}}': 'po-101' });
    expect(e.outbox.sent).toHaveLength(0);
    const resumed = await e.harness.execute({ ctx: e.ctx, proposalId: p.id });
    expect(resumed.status).toBe('executed');
    expect(e.erp.writes).toBe(1);
    expect(e.outbox.sent[0]!.po).toBe('PO-101');
  });

  test('an op whose reference cannot be resolved fails (not retried) with code unresolved_reference', async () => {
    const e = env();
    const p = await e.harness.propose({ ctx: e.ctx, principal: agent, ops: [{ action: 'purchases.upsert', input: po }, { action: 'notify.send', input: { ...note(0), text: 'see {{op:0.nope}}' } }] });
    await e.harness.decide({ ctx: e.ctx, principal: approver, proposalId: p.id, decision: 'approve' });
    const done = await e.harness.execute({ ctx: e.ctx, proposalId: p.id });
    expect(done.status).toBe('failed');
    expect(done.ops[1]!.result).toMatchObject({ attempts: 0, error: { name: 'UnresolvedReferenceError', code: 'unresolved_reference' } });
    expect(e.outbox.sent).toHaveLength(0);
  });
});

describe('routeErrorClassifier', () => {
  class AError extends Error {}
  class BError extends Error {}
  const a: ErrorClassifier = { isRetryable: (e) => e instanceof AError, retryAfterMs: () => 1000 };
  const b: ErrorClassifier = { isRetryable: (e) => e instanceof BError };

  test('routes by the op connector; falls back to "any" without a context', () => {
    const c = routeErrorClassifier({ alpha: a, beta: b });
    const alpha: ErrorContext = { action: 'alpha.x', connectorId: 'alpha' };
    expect(c.isRetryable(new AError(), alpha)).toBe(true);
    expect(c.isRetryable(new BError(), alpha)).toBe(false);
    expect(c.retryAfterMs?.(new AError(), alpha)).toBe(1000);
    expect(c.isRetryable(new BError(), { action: 'beta.y', connectorId: 'beta' })).toBe(true);
    expect(c.isRetryable(new BError())).toBe(true);
    expect(c.retryAfterMs?.(new AError())).toBe(1000);
    expect(c.isRetryable(new Error('x'), { action: 'plain' })).toBe(false);
  });

  test('the executor passes the op connector to the classifier', async () => {
    const seen: Array<ErrorContext | undefined> = [];
    const erp = new FakeErp();
    erp.failures.push(new HttpError(503));
    const connector = defineConnector<Ctx>({ id: 'erp', system: 'erp', description: 'fake', actions: [purchaseUpsertAction('low')] });
    const harness = createHarness<Ctx>({
      registry: Registry.fromConnectors([connector]),
      store: new InMemoryProposalStore(),
      audit: new InMemoryAuditSink(),
      clock: new FakeClock(),
      policyRules: new StaticPolicyRules([]),
      random: () => 0,
      errors: {
        isRetryable: (err, ctx) => {
          seen.push(ctx);
          return err instanceof HttpError;
        },
      },
    });
    const p = await harness.propose({ ctx: { erp }, principal: agent, ops: [{ action: 'erp.purchases.upsert', input: po }] });
    await harness.decide({ ctx: { erp }, principal: approver, proposalId: p.id, decision: 'approve' });
    expect((await harness.execute({ ctx: { erp }, proposalId: p.id })).status).toBe('executed');
    expect(seen).toEqual([{ action: 'erp.purchases.upsert', connectorId: 'erp' }]);
  });
});

describe('registry provider', () => {
  test('a harness built with () => registry sees connectors added later', async () => {
    const erp = new FakeErp();
    let registry = new Registry<Ctx>();
    const harness = createHarness<Ctx>({ registry: () => registry, store: new InMemoryProposalStore(), audit: new InMemoryAuditSink(), policyRules: new StaticPolicyRules([]) });
    await expect(harness.propose({ ctx: { erp }, principal: agent, ops: [{ action: 'purchases.upsert', input: po }] })).rejects.toThrow("Unknown action 'purchases.upsert'");
    registry = new Registry<Ctx>({ actions: [purchaseUpsertAction()] });
    expect(harness.registry).toBe(registry);
    const p = await harness.propose({ ctx: { erp }, principal: agent, ops: [{ action: 'purchases.upsert', input: po }] });
    expect(p.ops).toHaveLength(1);
  });
});

describe('moneyless actions', () => {
  test('a moneyless op counts as 0, so max_total_value still denies a proposal that also sends an email', async () => {
    const erp = new FakeErp();
    const outbox = new Outbox();
    const moneyless = defineAction({ ...notifyAction, moneyless: true });
    const rules = new StaticPolicyRules([{ key: 'max_total_value', params: { max: 1000 } }]);
    const make = (notify: typeof notifyAction) =>
      createHarness<NotifyCtx>({ registry: new Registry<NotifyCtx>({ actions: [poWithOutputs(), notify] }), store: new InMemoryProposalStore(), audit: new InMemoryAuditSink(), policyRules: rules });
    const big = { vendorId: 'v', items: [{ productId: 's', quantity: 1000, unitPrice: 5 }] };
    const ops = [{ action: 'purchases.upsert', input: big }, { action: 'notify.send', input: note(0) }];

    const withFlag = await make(moneyless).propose({ ctx: { erp, outbox }, principal: agent, ops });
    expect(withFlag.ops[1]!.value).toBe(0);
    expect(withFlag.status).toBe('denied');
    expect(withFlag.policy.reasons.find((r) => r.rule === 'max_total_value')?.outcome).toBe('deny');

    // Without the flag the total is unknown: the cap cannot be checked, so it asks a human (fail closed).
    const without = await make(notifyAction).propose({ ctx: { erp, outbox }, principal: agent, ops });
    expect(without.ops[1]!.value).toBeNull();
    expect(without.status).toBe('pending_approval');
  });
});
