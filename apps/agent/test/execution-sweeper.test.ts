/**
 * Execution reliability: when the queue (Inngest) is unreachable at decision / auto-approval time a
 * pending-execution marker is recorded, and the sweeper enqueues approved / auto-approved proposals
 * with no execution started, idempotently. Resume of failed proposals goes through the same executor.
 */
import { describe, expect, test } from 'bun:test';
import { agentPrincipal, userPrincipal, type Proposal } from '@ops/harness';
import {
  afterDecision,
  afterPropose,
  executeApprovedProposal,
  guardedAfterDecision,
  InMemoryPendingExecutionStore,
  sendWithMarker,
  sweepPendingExecutions,
  type DecisionRuns,
  type SendApproved,
  type SendOptions,
} from '../src/mastra/proposal-executor';
import { mcpEnv } from './fixtures/mcp-env';

const NOW = new Date('2026-11-19T12:00:00Z');
const approver = userPrincipal('u-ap', 'approver', 'Ana');

function proposal(status: Proposal['status'], overrides: Partial<Proposal> = {}): Proposal {
  const at = new Date(NOW.getTime() - 10 * 60_000).toISOString();
  return {
    id: crypto.randomUUID(),
    version: 2,
    status,
    title: 'Restock',
    rationale: null,
    meta: {},
    createdBy: agentPrincipal('procurement-planner'),
    createdAt: at,
    updatedAt: at,
    ops: [],
    policy: { outcome: 'needs_approval', reasons: [] },
    decision: status === 'approved' || status === 'rejected' ? { decision: status === 'approved' ? 'approve' : 'reject', by: approver, reason: null, edited: false, at } : null,
    execution: null,
    ...overrides,
  };
}

/** An Inngest stand-in: up/down switch, dedupe by event id. */
function queue() {
  const q = { up: true, sent: [] as Array<{ proposalId: string } & SendOptions>, ids: new Set<string>() };
  const send: SendApproved = async (proposalId, options = {}) => {
    if (!q.up) throw new Error('fetch failed: Inngest unreachable');
    const id = options.eventId ?? `proposal-approved-${proposalId}`;
    if (q.ids.has(id)) return;
    q.ids.add(id);
    q.sent.push({ proposalId, ...options });
  };
  return { q, send };
}

const runsWith = (statuses: Record<string, string | null>, resumed: string[] = []): DecisionRuns => ({
  status: async (runId) => statuses[runId] ?? null,
  resume: async (runId) => {
    if (statuses[runId] !== 'suspended') return false;
    resumed.push(runId);
    return true;
  },
});

describe('pending-execution markers', () => {
  test('auto-approval while the queue is down records a marker; the sweeper enqueues it and clears the marker', async () => {
    const store = new InMemoryPendingExecutionStore(() => NOW);
    const { q, send } = queue();
    const p = proposal('auto_approved', { updatedAt: NOW.toISOString() }); // fresh: inside the grace period
    q.up = false;
    await expect(afterPropose(sendWithMarker(send, store, 'auto_approval'))(p)).rejects.toThrow('unreachable');
    expect((await store.list()).map((m) => [m.proposalId, m.reason, m.attempts])).toEqual([[p.id, 'auto_approval', 1]]);

    // Still down: the sweep fails, the marker stays (attempts counted).
    let r = await sweepPendingExecutions({ store, stalled: async () => [], get: async () => p, runs: runsWith({}), send, now: () => NOW });
    expect(r.failed.map((f) => f.proposalId)).toEqual([p.id]);
    expect((await store.list())[0]?.attempts).toBe(2);

    q.up = true;
    r = await sweepPendingExecutions({ store, stalled: async () => [], get: async () => p, runs: runsWith({}), send, now: () => NOW });
    expect(r.enqueued).toEqual([p.id]);
    expect(r.cleared).toEqual([p.id]);
    expect(q.sent).toEqual([{ proposalId: p.id, eventId: `proposal-approved-${p.id}` }]);
    expect(await store.list()).toEqual([]);

    // Idempotent: a second sweep with nothing stalled does nothing.
    r = await sweepPendingExecutions({ store, stalled: async () => [], get: async () => p, runs: runsWith({}), send, now: () => NOW });
    expect(r.checked).toBe(0);
  });

  test('a decision whose follow-up fails (resume or queue) is marked; the sweeper resumes the suspended run', async () => {
    const store = new InMemoryPendingExecutionStore(() => NOW);
    const p = proposal('approved', { meta: { workflowRunId: 'run-1', workflowId: 'restock' } });
    const failingRuns: DecisionRuns = {
      status: async () => 'suspended',
      resume: async () => {
        throw new Error('Inngest unreachable');
      },
    };
    const hook = guardedAfterDecision(afterDecision({ runs: failingRuns, send: queue().send }), store);
    await expect(hook(p)).rejects.toThrow('unreachable');
    expect((await store.list()).map((m) => m.reason)).toEqual(['decision']);

    const resumed: string[] = [];
    const { q, send } = queue();
    const r = await sweepPendingExecutions({ store, stalled: async () => [p], get: async () => p, runs: runsWith({ 'run-1': 'suspended' }, resumed), send, now: () => NOW });
    expect(r.resumed).toEqual([p.id]);
    expect(resumed).toEqual(['run-1']);
    expect(q.sent).toEqual([]); // the run executes it, not proposal-execute
    expect(await store.list()).toEqual([]);
  });
});

describe('sweeper over stalled proposals', () => {
  test('run-less approvals are enqueued; running runs are left alone; finished runs hand over; bucketed ids throttle re-sends', async () => {
    const store = new InMemoryPendingExecutionStore(() => NOW);
    const runLess = proposal('approved');
    const running = proposal('auto_approved', { meta: { workflowRunId: 'run-running' } });
    const finished = proposal('approved', { meta: { workflowRunId: 'run-done' } });
    const executing = proposal('executing');
    const { q, send } = queue();
    const deps = {
      store,
      stalled: async () => [runLess, running, finished, executing],
      get: async () => null,
      runs: runsWith({ 'run-running': 'running', 'run-done': 'success' }),
      send,
      now: () => NOW,
    };
    const r = await sweepPendingExecutions(deps);
    expect(r.enqueued.sort()).toEqual([runLess.id, finished.id].sort());
    expect(r.skipped.sort()).toEqual([running.id, executing.id].sort());
    expect(q.sent.every((s) => s.eventId?.startsWith('proposal-sweep-'))).toBe(true);

    // Same 10-minute bucket: the stand-in dedupes (as Inngest would), nothing new is delivered.
    await sweepPendingExecutions(deps);
    expect(q.sent.length).toBe(2);
    // Next bucket: re-sent once more (in case the earlier event never ran); the executor is idempotent.
    await sweepPendingExecutions({ ...deps, now: () => new Date(NOW.getTime() + 10 * 60_000) });
    expect(q.sent.length).toBe(4);
  });
});

describe('resume a failed proposal through the executor', () => {
  test('failed proposals run only on a resume event; executed ops are skipped', async () => {
    const env = await mcpEnv();
    try {
      const bd = await env.registry.runReadTool(env.distru, agentPrincipal('t'), 'distru.products_get', { sku: 'FLW-BD-35' });
      const product = bd as { id: string; vendor: { id: string } };
      const loc = (await env.distru.connectors.distru.listLocations({})).data![0]!;
      const p = await env.harness.propose({
        ctx: env.distru,
        principal: agentPrincipal('procurement-planner'),
        ops: [{ action: 'distru.purchases.upsert', input: { vendor_id: product.vendor.id, location_id: loc.id, lines: [{ product_id: product.id, quantity: 600, unit_price: 14 }] } }],
      });
      await env.harness.decide({ ctx: env.distru, principal: approver, proposalId: p.id, decision: 'approve' });
      // Fail the write once (400: not retryable) → failed.
      const original = env.distru.connectors.distru.upsertPurchase;
      env.distru.connectors.distru.upsertPurchase = async () => {
        throw Object.assign(new Error('Distru 400: vendor on hold'), { status: 400 });
      };
      const failed = await env.harness.execute({ ctx: env.distru, proposalId: p.id });
      env.distru.connectors.distru.upsertPurchase = original;
      expect(failed.status).toBe('failed');

      // A plain (non-resume) event leaves it alone; a resume runs it.
      expect((await executeApprovedProposal(env.harness, env.distru, p.id)).status).toBe('failed');
      await env.harness.requestResume({ principal: approver, proposalId: p.id, reason: 'vendor released the hold' });
      expect((await executeApprovedProposal(env.harness, env.distru, p.id, { resume: true })).status).toBe('executed');
    } finally {
      await env.close();
    }
  });
});
