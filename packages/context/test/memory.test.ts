import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  agentPrincipal,
  createHarness,
  defineAction,
  FakeClock,
  InMemoryAuditSink,
  InMemoryProposalStore,
  Registry,
  sequentialIds,
  StaticPolicyRules,
  userPrincipal,
  type Proposal,
  type ProposalOp,
} from '@ops/harness';
import { categorizeReason, contextFor, forget, ingestHarnessEvents, InMemoryContextStore, remember, signalsFromAudit, type HarnessSignal } from '../src';

const NOW = '2026-11-19T12:00:00.000Z';
const MPR = 'vendor-mpr';
const CCV = 'vendor-ccv';
const SEC = 'vendor-sec';
const PREROLL = 'prod-preroll';

async function storeWithNames() {
  const store = new InMemoryContextStore();
  const base = { source: 'distru', sourceUpdatedAt: null, syncedAt: NOW, deletedAt: null, category: null, email: null, promisedLeadTimeDays: 7, relationship: 'vendor' as const };
  await store.upsert('company', [
    { ...base, sourceId: MPR, name: 'Mojave Pre-Roll Co.' },
    { ...base, sourceId: CCV, name: 'Coastal Cloud Vapes' },
    { ...base, sourceId: SEC, name: 'Sierra Extracts Co.' },
  ]);
  await store.upsert('product', [{ source: 'distru', sourceId: PREROLL, sku: 'PRE-BD-1G', name: 'Blue Dream Pre-Roll 1g', category: null, vendorId: MPR, unitCost: 4, unitPrice: 9, unitsPerCase: 50, isActive: true, sourceUpdatedAt: null, syncedAt: NOW, deletedAt: null }]);
  return store;
}

const approver = { kind: 'user', id: 'u-ana', label: 'Ana Approver' };
const day = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

function decision(i: number, vendor: string, proposed: number, final: number, extra: Partial<Extract<HarnessSignal, { kind: 'decision' }>> = {}): HarnessSignal {
  return {
    id: `audit-${vendor}-${i}`,
    at: day(30 - i),
    kind: 'decision',
    proposalId: `p-${vendor}-${i}`,
    decision: 'approve',
    reason: null,
    edited: proposed !== final,
    by: approver,
    ops: [{ index: 0, action: 'distru.purchases.upsert', vendorIds: [vendor], proposed: [{ productId: PREROLL, quantity: proposed }], final: [{ productId: PREROLL, quantity: final }] }],
    ...extra,
  };
}

const rejection = (i: number, vendor: string, reason: string): HarnessSignal => ({
  id: `rej-${vendor}-${i}`,
  at: day(20 - i),
  kind: 'decision',
  proposalId: `pr-${vendor}-${i}`,
  decision: 'reject',
  reason,
  edited: false,
  by: approver,
  ops: [{ index: 0, action: 'distru.purchases.upsert', vendorIds: [vendor], proposed: [{ productId: 'prod-x', quantity: 50 }], final: [{ productId: 'prod-x', quantity: 50 }] }],
});

function syntheticSignals(): HarnessSignal[] {
  return [
    // approver trims Mojave 4 of 5 edits (~20%), one edit raises
    decision(1, MPR, 500, 400),
    decision(2, MPR, 300, 240),
    decision(3, MPR, 250, 205),
    decision(4, MPR, 400, 312),
    decision(5, MPR, 100, 120),
    // Coastal Cloud rejected over price 3 times
    rejection(1, CCV, 'Too expensive this month'),
    rejection(2, CCV, 'Price went up again, push back'),
    rejection(3, CCV, 'cheaper elsewhere'),
    // Sierra vetoed by compliance twice (once as policy denial, once as an explicit veto) + a duplicate
    { id: 'veto-1', at: day(9), kind: 'compliance_veto', proposalId: 'p-sec-1', vendorIds: [SEC], productIds: ['prod-wc'], reason: 'Batch failed lab test (pesticides)', by: { kind: 'agent', id: 'compliance-reviewer' } },
    { id: 'deny-1', at: day(9), kind: 'policy_denied', proposalId: 'p-sec-1', vendorIds: [SEC], productIds: ['prod-wc'], rules: ['compliance_hold'], messages: ['Batch on hold'] },
    { id: 'deny-2', at: day(4), kind: 'policy_denied', proposalId: 'p-sec-2', vendorIds: [SEC], productIds: ['prod-wc'], rules: ['compliance_hold'], messages: ['COA expired'] },
    // the PO cap was raised
    { id: 'rule-1', at: day(3), kind: 'policy_rule_changed', key: 'max_total_value', before: { max: 25000 }, after: { max: 40000 }, by: approver },
  ];
}

describe('memories from harness signals', () => {
  test('learns explainable memories with evidence and confidence', async () => {
    const store = await storeWithNames();
    const clock = new FakeClock(NOW);
    const res = await ingestHarnessEvents(store, syntheticSignals(), { clock });
    expect(res.newSignals).toBe(12);
    const all = await store.listMemories({ statuses: ['active'] });
    const byKey = (scopeId: string | null, key: string) => all.find((m) => m.scopeId === scopeId && m.key === key);

    const trim = byKey(MPR, 'qty_trim')!;
    expect(trim.statement).toBe('Approver trims Mojave Pre-Roll Co. POs by ~20% (4 of 5 edits)');
    expect(trim.evidence.proposalIds).toEqual(['p-vendor-mpr-1', 'p-vendor-mpr-2', 'p-vendor-mpr-3', 'p-vendor-mpr-4']);
    expect(trim.evidenceCount).toBe(4);
    expect(trim.confidence).toBe(0.8);
    expect(trim.lastConfirmedAt).toBe(day(26));
    expect(byKey(PREROLL, 'qty_trim')!.statement).toContain('Blue Dream Pre-Roll 1g (PRE-BD-1G) lines');

    const price = byKey(CCV, 'rejection:price')!;
    expect(price.statement).toContain('Proposals for Coastal Cloud Vapes are often rejected over price (3 of 3 rejections');
    expect(price.evidence.auditIds.length).toBe(3);

    const veto = byKey(SEC, 'compliance_veto')!;
    expect(veto.statement).toMatch(/^Sierra Extracts Co\. has been vetoed by compliance 2 times/); // p-sec-1 counted once
    expect(veto.evidence.proposalIds.sort()).toEqual(['p-sec-1', 'p-sec-2']);

    const cap = byKey(null, 'policy:max_total_value')!;
    expect(cap.scope).toBe('global');
    expect(cap.statement).toContain('max raised from $25,000 to $40,000 by Ana Approver on 2026-11-16');
  });

  test('idempotent and deduped: re-ingesting the same or overlapping batches does not duplicate', async () => {
    const store = await storeWithNames();
    const clock = new FakeClock(NOW);
    await ingestHarnessEvents(store, syntheticSignals(), { clock });
    const count = (await store.listMemories()).length;
    const again = await ingestHarnessEvents(store, syntheticSignals(), { clock });
    expect(again.newSignals).toBe(0);
    expect(again.upserted).toEqual([]);
    expect((await store.listMemories()).length).toBe(count);
    // one more trim strengthens the same memory
    await ingestHarnessEvents(store, [decision(6, MPR, 200, 160)], { clock });
    const trim = (await store.listMemories({ scope: 'vendor', scopeIds: [MPR] })).find((m) => m.key === 'qty_trim')!;
    expect(trim.statement).toBe('Approver trims Mojave Pre-Roll Co. POs by ~20% (5 of 6 edits)');
    expect((await store.listMemories()).length).toBe(count);
  });

  test('memories decay and expire without confirmation; retracted ones are not relearned', async () => {
    const store = await storeWithNames();
    const clock = new FakeClock(NOW);
    await ingestHarnessEvents(store, syntheticSignals(), { clock });
    const trim = (await store.listMemories({ scope: 'vendor', scopeIds: [MPR] })).find((m) => m.key === 'qty_trim')!;
    expect(await forget(store, trim.id)).toBe(true);
    await ingestHarnessEvents(store, [decision(7, MPR, 200, 150)], { clock });
    expect((await store.getMemory(trim.id))!.status).toBe('retracted');

    clock.advance(400 * 86_400_000);
    const res = await ingestHarnessEvents(store, [], { clock });
    expect(res.expired.length).toBeGreaterThan(0);
    expect((await store.listMemories({ statuses: ['active'] })).filter((m) => m.origin === 'learned')).toEqual([]);
  });

  test('explicit memories: remember() dedupes, merges evidence and shows in retrieval', async () => {
    const store = await storeWithNames();
    const clock = new FakeClock(NOW);
    const a = await remember(store, { statement: 'Mojave only delivers on Tuesdays', scope: 'vendor', scopeId: MPR, by: 'user:u-ana', evidence: { refs: ['thread-1'] } }, { clock });
    const b = await remember(store, { statement: 'mojave only delivers on tuesdays.', scope: 'vendor', scopeId: MPR, evidence: { refs: ['thread-2'] } }, { clock });
    expect(b.id).toBe(a.id);
    expect(b.evidence.refs.sort()).toEqual(['thread-1', 'thread-2', 'user:u-ana']);
    expect(b.data.confirmations).toBe(2);
    await expect(remember(store, { statement: 'x', scope: 'vendor' })).rejects.toThrow(/scopeId/);
    const block = await contextFor(store, { vendorIds: [MPR] }, { clock });
    expect(block.text).toContain('(vendor, told) Mojave only delivers on Tuesdays');
  });

  test('categorizes rejection reasons', () => {
    expect(categorizeReason('Too expensive')).toBe('price');
    expect(categorizeReason('COA missing for batch')).toBe('compliance');
    expect(categorizeReason('we already ordered this')).toBe('duplicate');
    expect(categorizeReason('order 2 cases fewer, too many units')).toBe('quantity');
    expect(categorizeReason(null)).toBe('other');
  });
});

describe('signalsFromAudit (real harness flow)', () => {
  type Ctx = { vendorName: string };
  const Input = z.object({ vendor_id: z.string(), lines: z.array(z.object({ product_id: z.string(), quantity: z.number(), price: z.number() })) });
  type In = z.infer<typeof Input>;
  const createPo = defineAction<Ctx, In, In, In>({
    name: 'po.create',
    resource: 'purchases',
    risk: 'medium',
    description: 'Create a PO',
    input: Input,
    loadBefore: async () => null,
    plan: (_ctx, input) => input,
    execute: async (_ctx, payload) => ({ recordId: 'po-1', record: payload }),
    verify: async () => ({ ok: true, mismatches: [] }),
    findByIdempotencyKey: async () => null,
    valueOf: (p) => p.lines.reduce((s, l) => s + l.quantity * l.price, 0),
    vendorIdsOf: (p) => [p.vendor_id],
  });

  test('decided proposals with approver edits become learnable signals', async () => {
    const clock = new FakeClock(NOW);
    const proposals = new InMemoryProposalStore();
    const audit = new InMemoryAuditSink();
    const harness = createHarness<Ctx>({
      registry: new Registry({ actions: [createPo] }),
      store: proposals,
      audit,
      clock,
      ids: sequentialIds('h'),
      policyRules: new StaticPolicyRules([{ key: 'max_total_value', params: { max: 100_000 } }]),
    });
    const ctx = { vendorName: 'Mojave' };
    const planner = agentPrincipal('procurement-planner');
    const ana = userPrincipal('u-ana', 'approver', 'Ana Approver');
    const compliance = userPrincipal('compliance-officer', 'approver', 'Compliance');
    const original = new Map<string, ProposalOp[]>();
    for (const [qty, finalQty] of [
      [500, 400],
      [300, 240],
      [250, 200],
    ] as const) {
      const p = await harness.propose({ ctx, principal: planner, ops: [{ action: 'po.create', input: { vendor_id: MPR, lines: [{ product_id: PREROLL, quantity: qty, price: 4 }] } }] });
      original.set(p.id, p.ops); // the app captures ops before decide
      await harness.decide({ ctx, principal: ana, proposalId: p.id, decision: 'approve', edits: [{ opIndex: 0, input: { vendor_id: MPR, lines: [{ product_id: PREROLL, quantity: finalQty, price: 4 }] } }] });
    }
    const vetoed = await harness.propose({ ctx, principal: planner, ops: [{ action: 'po.create', input: { vendor_id: SEC, lines: [{ product_id: 'prod-wc', quantity: 10, price: 16 }] } }] });
    await harness.decide({ ctx, principal: compliance, proposalId: vetoed.id, decision: 'reject', reason: 'Failed lab test' });

    const byId = new Map<string, Proposal>();
    for (const p of await proposals.list()) byId.set(p.id, p);
    const signals = signalsFromAudit(audit.events, { proposal: (id) => byId.get(id), proposedOps: (id) => original.get(id) });
    const decisions = signals.filter((s) => s.kind === 'decision');
    expect(decisions.length).toBe(4);
    expect(signals.some((s) => s.kind === 'compliance_veto' && s.vendorIds[0] === SEC)).toBe(true);
    const first = decisions[0]!;
    if (first.kind !== 'decision') throw new Error('unreachable');
    expect(first.ops[0]!.proposed[0]!.quantity).toBe(500);
    expect(first.ops[0]!.final[0]!.quantity).toBe(400);

    const store = await storeWithNames();
    await ingestHarnessEvents(store, signals, { clock });
    const trim = (await store.listMemories({ scope: 'vendor', scopeIds: [MPR] })).find((m) => m.key === 'qty_trim')!;
    expect(trim.statement).toBe('Approver trims Mojave Pre-Roll Co. POs by ~20% (3 of 3 edits)');
    expect(trim.evidence.auditIds.length).toBe(3);
  });
});
