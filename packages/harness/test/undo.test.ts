import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  createHarness,
  defineAction,
  FakeClock,
  InMemoryAuditSink,
  InMemoryProposalStore,
  InputValidationError,
  matchesExpected,
  opRef,
  Registry,
  sequentialIds,
  StaticPolicyRules,
  UndoUnavailableError,
  type PolicyRuleConfig,
} from '../src';
import { agent, approver, approver2, operator } from './fixtures';

// A tiny ERP with deletable POs, notes linked to a PO, and an outbox.
interface Po {
  id: string;
  status: string;
  qty: number;
  ref: string;
}
interface Note {
  id: string;
  poId: string;
  text: string;
  ref: string;
}
class Erp {
  pos = new Map<string, Po>();
  notes = new Map<string, Note>();
  sent: string[] = [];
  deletes = 0;
  n = 1;
}
interface Ctx {
  erp: Erp;
}

const PoInput = z.object({ id: z.string().optional(), qty: z.number().int().positive(), status: z.string().default('PENDING') });
const poAction = defineAction({
  name: 'po.upsert',
  resource: 'po',
  risk: 'medium',
  description: 'Create/update a PO',
  input: PoInput,
  loadBefore: async (ctx: Ctx, input) => (input.id ? structuredClone(ctx.erp.pos.get(input.id) ?? null) : null),
  plan: (_ctx: Ctx, input) => ({ ...(input.id ? { id: input.id } : {}), qty: input.qty, status: input.status }),
  execute: async (ctx: Ctx, payload, key) => {
    const id = payload.id ?? `po-${ctx.erp.n++}`;
    const po = { ...(ctx.erp.pos.get(id) ?? { ref: key }), id, qty: payload.qty, status: payload.status };
    ctx.erp.pos.set(id, po);
    return { recordId: id, record: structuredClone(po) };
  },
  findByIdempotencyKey: async (ctx: Ctx, key) => {
    const po = [...ctx.erp.pos.values()].find((p) => p.ref === key);
    return po ? { recordId: po.id, record: structuredClone(po) } : null;
  },
  verify: async (ctx: Ctx, id, expected) => matchesExpected(ctx.erp.pos.get(id), { qty: expected.qty, status: expected.status }),
  valueOf: (payload) => payload.qty * 10,
  outputs: (record) => ({ status: record.status }),

  canCompensate: (op) => {
    const before = z.object({ status: z.string() }).nullable().parse(op.before ?? null);
    return before?.status === 'RECEIVED' ? { ok: false, reason: 'A received PO cannot be undone' } : { ok: true };
  },
  planCompensation: async (ctx: Ctx, op, result) => {
    const current = structuredClone(ctx.erp.pos.get(result.recordId!) ?? null);
    if (current?.status === 'RECEIVED') throw new InputValidationError('PO was received meanwhile');
    if (op.before === null) return { current: current && { status: current.status, qty: current.qty }, target: null, summary: `Delete ${result.recordId}`, value: 0 };
    const before = z.object({ qty: z.number(), status: z.string() }).parse(op.before);
    return { current: current && { status: current.status, qty: current.qty }, target: { qty: before.qty, status: before.status }, value: before.qty * 10 };
  },
  compensate: async (ctx: Ctx, op, result) => {
    const id = result.recordId!;
    if (op.before === null) {
      ctx.erp.deletes++;
      ctx.erp.pos.delete(id); // idempotent: deleting twice is fine
      return { recordId: id, record: null };
    }
    const before = z.object({ qty: z.number(), status: z.string() }).parse(op.before);
    const po = { ...ctx.erp.pos.get(id)!, qty: before.qty, status: before.status };
    ctx.erp.pos.set(id, po);
    return { recordId: id, record: po };
  },
});

const noteAction = defineAction({
  name: 'note.create',
  resource: 'note',
  risk: 'low',
  description: 'Note on a PO',
  input: z.object({ poId: z.string(), text: z.string() }),
  loadBefore: async () => null,
  plan: (_ctx: Ctx, input) => input,
  execute: async (ctx: Ctx, payload, key) => {
    const note = { id: `n-${ctx.erp.n++}`, poId: payload.poId, text: payload.text, ref: key };
    ctx.erp.notes.set(note.id, note);
    return { recordId: note.id, record: note };
  },
  findByIdempotencyKey: async (ctx: Ctx, key) => {
    const n = [...ctx.erp.notes.values()].find((x) => x.ref === key);
    return n ? { recordId: n.id, record: n } : null;
  },
  verify: async (ctx: Ctx, id, expected) => matchesExpected(ctx.erp.notes.get(id), { poId: expected.poId }),
  valueOf: undefined,
  moneyless: true,
  planCompensation: async (ctx: Ctx, op, result) => {
    // The hook sees the resolved payload (real PO id), not the {{op:0.recordId}} placeholder.
    const payload = z.object({ poId: z.string() }).parse(op.payload);
    const n = ctx.erp.notes.get(result.recordId!);
    return { current: n ? { poId: payload.poId, text: n.text } : null, target: null };
  },
  compensate: async (ctx: Ctx, _op, result) => {
    ctx.erp.notes.delete(result.recordId!);
    return { recordId: result.recordId!, record: null };
  },
});

const mailAction = defineAction({
  name: 'mail.send',
  resource: 'mail',
  risk: 'high',
  description: 'Send an email',
  input: z.object({ text: z.string() }),
  loadBefore: async () => null,
  plan: (_ctx: Ctx, input) => input,
  execute: async (ctx: Ctx, payload) => {
    ctx.erp.sent.push(payload.text);
    return { recordId: `m-${ctx.erp.sent.length}`, record: payload };
  },
  findByIdempotencyKey: async () => null,
  verify: async () => ({ ok: true, mismatches: [] }),
  valueOf: undefined,
  moneyless: true,
  irreversible: 'An email cannot be unsent: send a correction instead.',
});

function env(options: { rules?: PolicyRuleConfig[]; undoWindowMs?: number } = {}) {
  const erp = new Erp();
  const store = new InMemoryProposalStore();
  const audit = new InMemoryAuditSink();
  const clock = new FakeClock('2026-11-19T12:00:00Z');
  const harness = createHarness<Ctx>({
    registry: new Registry<Ctx>({ actions: [poAction, noteAction, mailAction] }),
    store,
    audit,
    clock,
    ids: sequentialIds('p'),
    policyRules: new StaticPolicyRules(options.rules ?? [{ key: 'auto_approve_below', params: { amount: 1_000_000, max_risk: 'medium' } }]),
    ...(options.undoWindowMs !== undefined ? { undoWindowMs: options.undoWindowMs } : {}),
  });
  return { erp, store, audit, clock, harness, ctx: { erp } };
}

/** PO (create) → note linked to it (op ref) → email, all executed. */
async function executedCrossTool(e: ReturnType<typeof env>) {
  const p = await e.harness.propose({
    ctx: e.ctx,
    principal: agent,
    title: 'Restock',
    ops: [
      { action: 'po.upsert', input: { qty: 12 } },
      { action: 'note.create', input: { poId: opRef(0, 'recordId'), text: 'receive it' } },
      { action: 'mail.send', input: { text: 'PO sent' } },
    ],
  });
  await e.harness.decide({ ctx: e.ctx, principal: approver, proposalId: p.id, decision: 'approve' });
  const done = await e.harness.execute({ ctx: e.ctx, proposalId: p.id });
  expect(done.status).toBe('executed');
  return done;
}

describe('undo availability', () => {
  test('lists every op with canUndo + why not (email irreversible)', async () => {
    const e = env();
    const done = await executedCrossTool(e);
    const info = await e.harness.undoInfo(done.id);
    expect(info.available).toBe(true);
    expect(info.ops.map((o) => [o.opIndex, o.canUndo])).toEqual([
      [0, true],
      [1, true],
      [2, false],
    ]);
    expect(info.ops[2]!.reason).toContain('cannot be unsent');
  });

  test('not available before execution, for failed ops, after the window, and for undo proposals', async () => {
    const e = env({ undoWindowMs: 60_000 });
    const pending = await e.harness.propose({ ctx: e.ctx, principal: agent, ops: [{ action: 'mail.send', input: { text: 'x' } }] });
    expect((await e.harness.undoInfo(pending.id)).reason).toContain('pending_approval');
    await expect(e.harness.undo({ ctx: e.ctx, principal: operator, proposalId: pending.id, reason: 'oops' })).rejects.toBeInstanceOf(UndoUnavailableError);

    const done = await executedCrossTool(e);
    const undoP = await e.harness.undo({ ctx: e.ctx, principal: operator, proposalId: done.id, reason: 'wrong vendor' });
    expect((await e.harness.undoInfo(undoP.id)).reason).toContain('itself an undo');

    e.clock.advance(61_000);
    const late = await e.harness.undoInfo(done.id);
    expect(late.available).toBe(false);
    expect(late.reason).toContain('undo window closed');
  });
});

describe('harness.undo', () => {
  test('creates a NEW pending proposal of compensating ops in reverse order; nothing is written until approved', async () => {
    const e = env();
    const done = await executedCrossTool(e);
    const poId = done.ops[0]!.result!.recordId!;
    const noteId = done.ops[1]!.result!.recordId!;

    const u = await e.harness.undo({ ctx: e.ctx, principal: operator, proposalId: done.id, reason: 'Vendor cancelled' });
    // Auto-approve rule would allow it ($0, medium) but undos always need a human.
    expect(u.status).toBe('pending_approval');
    expect(u.policy.reasons.some((r) => r.rule === 'undo_requires_approval')).toBe(true);
    expect(u.ops.map((o) => o.action)).toEqual(['note.create.undo', 'po.upsert.undo']);
    expect(u.meta.undoOf).toEqual({ proposalId: done.id, opIndexes: [1, 0] });
    expect(u.meta.notUndoable).toEqual([{ opIndex: 2, reason: 'An email cannot be unsent: send a correction instead.' }]);
    expect(u.ops[1]!.diff).toEqual([{ path: [], kind: 'removed', before: { status: 'PENDING', qty: 12 }, after: undefined }]);
    expect(u.ops[1]!.summary).toBe(`Delete ${poId}`);
    expect(u.ops[1]!.value).toBe(0);
    expect(e.erp.pos.has(poId)).toBe(true);
    expect(e.erp.notes.has(noteId)).toBe(true);

    // Linked both ways + audited on the original.
    const original = await e.harness.get(done.id);
    expect((await e.harness.undoInfo(original)).undoProposalId).toBe(u.id);
    expect((await e.harness.undoInfo(original)).ops[0]!.reason).toContain(`undo proposal ${u.id}`);
    expect(e.audit.ofType('proposal.undo_proposed')[0]!.data).toMatchObject({ undoProposalId: u.id, opIndexes: [1, 0] });

    // Separation of duties applies to the undo too.
    await expect(e.harness.decide({ ctx: e.ctx, principal: operator, proposalId: u.id, decision: 'approve' })).rejects.toThrow();
    await e.harness.decide({ ctx: e.ctx, principal: approver2, proposalId: u.id, decision: 'approve' });
    const undone = await e.harness.execute({ ctx: e.ctx, proposalId: u.id });
    expect(undone.status).toBe('executed');
    expect(e.erp.notes.has(noteId)).toBe(false);
    expect(e.erp.pos.has(poId)).toBe(false);
    expect(e.erp.sent).toEqual(['PO sent']);
    expect(undone.ops.every((o) => o.result?.mismatches.length === 0)).toBe(true);

    // Re-executing writes nothing; the original cannot be undone twice.
    await e.harness.execute({ ctx: e.ctx, proposalId: u.id });
    expect(e.erp.deletes).toBe(1);
    const after = await e.harness.undoInfo(done.id);
    expect(after.available).toBe(false);
  });

  test('update → restores `before`; selected ops only; a rejected undo frees the op again', async () => {
    const e = env();
    e.erp.pos.set('po-x', { id: 'po-x', status: 'PENDING', qty: 5, ref: 'seed' });
    const p = await e.harness.propose({ ctx: e.ctx, principal: agent, ops: [{ action: 'po.upsert', input: { id: 'po-x', qty: 50 } }, { action: 'mail.send', input: { text: 'more' } }] });
    await e.harness.decide({ ctx: e.ctx, principal: approver, proposalId: p.id, decision: 'approve' });
    await e.harness.execute({ ctx: e.ctx, proposalId: p.id });
    expect(e.erp.pos.get('po-x')!.qty).toBe(50);

    await expect(e.harness.undo({ ctx: e.ctx, principal: operator, proposalId: p.id, opIndexes: [1], reason: 'x' })).rejects.toThrow(/cannot be unsent/);

    const u1 = await e.harness.undo({ ctx: e.ctx, principal: operator, proposalId: p.id, opIndexes: [0], reason: 'too many' });
    expect(u1.ops[0]!.diff).toEqual([{ path: ['qty'], kind: 'changed', before: 50, after: 5 }]);
    expect(u1.ops[0]!.value).toBe(50);
    await e.harness.decide({ ctx: e.ctx, principal: approver, proposalId: u1.id, decision: 'reject' });
    expect((await e.harness.undoInfo(p.id)).ops[0]!.canUndo).toBe(true);

    const u2 = await e.harness.undo({ ctx: e.ctx, principal: operator, proposalId: p.id, opIndexes: [0], reason: 'too many' });
    await e.harness.decide({ ctx: e.ctx, principal: approver, proposalId: u2.id, decision: 'approve' });
    const done = await e.harness.execute({ ctx: e.ctx, proposalId: u2.id });
    expect(done.status).toBe('executed');
    expect(e.erp.pos.get('po-x')!.qty).toBe(5);
  });

  test('policy still applies: allowed_actions covers `<action>.undo` of allowed actions; others are denied', async () => {
    const e = env({ rules: [{ key: 'allowed_actions', params: { actions: ['po.upsert', 'note.create', 'mail.send'] } }] });
    const done = await executedCrossTool(e);
    const u = await e.harness.undo({ ctx: e.ctx, principal: operator, proposalId: done.id, reason: 'x' });
    expect(u.status).toBe('pending_approval');

    const e2 = env({ rules: [{ key: 'allowed_actions', params: { actions: ['note.create', 'mail.send', 'po.upsert'] } }] });
    const done2 = await executedCrossTool(e2);
    const strict = createHarness<Ctx>({
      registry: new Registry<Ctx>({ actions: [poAction, noteAction, mailAction] }),
      store: e2.store,
      audit: e2.audit,
      policyRules: new StaticPolicyRules([{ key: 'allowed_actions', params: { actions: ['note.create'] } }]),
    });
    const denied = await strict.undo({ ctx: e2.ctx, principal: operator, proposalId: done2.id, reason: 'x' });
    expect(denied.status).toBe('denied');
  });

  test('a record that moved on cannot be undone (planCompensation refuses); read-only principals cannot undo', async () => {
    const e = env();
    const done = await executedCrossTool(e);
    e.erp.pos.get(done.ops[0]!.result!.recordId!)!.status = 'RECEIVED';
    await expect(e.harness.undo({ ctx: e.ctx, principal: operator, proposalId: done.id, opIndexes: [0], reason: 'x' })).rejects.toBeInstanceOf(InputValidationError);
    const reader = { kind: 'mcp-client' as const, id: 't1', scopes: ['read' as const] };
    await expect(e.harness.undo({ ctx: e.ctx, principal: reader, proposalId: done.id, reason: 'x' })).rejects.toThrow(/lacks the 'propose' scope/);
  });

  test('derived undo actions are not in the catalog', async () => {
    const e = env();
    expect(e.harness.registry.catalog().map((d) => d.name)).not.toContain('po.upsert.undo');
    expect(e.harness.registry.action('po.upsert.undo').name).toBe('po.upsert.undo');
    expect(() => e.harness.registry.action('mail.send.undo')).toThrow(/Unknown action/);
  });
});
