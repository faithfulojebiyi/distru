/**
 * Proposals no workflow run will execute (Copilot propose tools outside a run, MCP, scripts, undo):
 * the decision hook queues `ops/proposal.approved` and `proposal-execute` runs harness.execute with one
 * durable step per op. In-process: the Distru mock, the real decision path (`createDecider` +
 * `afterDecision`), and an Inngest stand-in that dedupes by event id (fixtures/mcp-env.ts).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { agentPrincipal, MemoStepRunner, createHarness, userPrincipal, DecisionConflictError, stepIds, type Proposal } from '@ops/harness';
import { z } from 'zod';
import { afterDecision, afterPropose, executeApprovedProposal, type DecisionRuns } from '../src/mastra/proposal-executor';
import { createHarnessTools } from '../src/mastra/tools/harness-tools';
import { mcpEnv, resultOf, type McpEnv } from './fixtures/mcp-env';

let env: McpEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const approver = userPrincipal('u-approver', 'approver', 'Ana Approver');

async function poInput(e: McpEnv, quantity: number) {
  const bd = z.object({ id: z.string(), vendor: z.object({ id: z.string() }) }).parse(await e.registry.runReadTool(e.distru, agentPrincipal('t'), 'distru.products_get', { sku: 'FLW-BD-35' }));
  const loc = (await e.distru.connectors.distru.listLocations({})).data![0]!;
  return { vendor_id: bd.vendor.id, location_id: loc.id, lines: [{ product_id: bd.id, quantity, unit_price: 14 }] };
}

const purchaseCount = async (e: McpEnv) => (await e.distru.connectors.distru.listAll(e.distru.connectors.distru.listPurchases, {})).length;

/** The Procurement Planner's propose tool outside a workflow run (Copilot / Studio). */
function copilotProposeTool(e: McpEnv) {
  const tools = createHarnessTools({ registry: e.registry, harness: e.harness, readCtx: () => e.distru, afterPropose: afterPropose(e.send) }, 'procurementPlanner');
  const tool = tools['propose_distru_purchases_upsert'];
  if (!tool?.execute) throw new Error('planner has no propose tool');
  return tool;
}

const ToolOut = z.object({ ok: z.literal(true), mode: z.literal('proposal'), proposal_id: z.string(), status: z.string() });

describe('run-less proposals are executed after approval', () => {
  test('Copilot-style proposal → approve (UI/Slack decision path) → executed + verified, exactly once', async () => {
    env = await mcpEnv();
    const before = await purchaseCount(env);
    const out = ToolOut.parse(await copilotProposeTool(env).execute!(await poInput(env, 120), {}));
    expect(out.status).toBe('pending_approval');
    expect(await purchaseCount(env)).toBe(before);

    await env.decide(out.proposal_id, approver, { decision: 'approve', reason: 'ok' });
    const done = await env.harness.get(out.proposal_id);
    expect(done.status).toBe('executed');
    expect(done.ops[0]!.status).toBe('executed');
    expect(done.ops[0]!.result).toMatchObject({ mismatches: [], error: null, deduplicated: false });
    expect(env.audit.ofType('op.verified').filter((e) => e.proposalId === out.proposal_id)).toHaveLength(1);
    expect(await purchaseCount(env)).toBe(before + 1);

    // A second approval (double click, Slack + UI) gets a conflict and queues nothing new.
    await expect(env.decide(out.proposal_id, userPrincipal('u-approver-2', 'approver'), { decision: 'approve' })).rejects.toBeInstanceOf(DecisionConflictError);
    expect(env.queue.sent.filter((id) => id === out.proposal_id)).toHaveLength(1);
    // Even a redelivered event (or a manual retry) writes nothing: the executed proposal is skipped.
    expect((await executeApprovedProposal(env.harness, env.distru, out.proposal_id)).status).toBe('executed');
    expect(await purchaseCount(env)).toBe(before + 1);
  });

  test('rejected run-less proposal → nothing queued, nothing written', async () => {
    env = await mcpEnv();
    const out = ToolOut.parse(await copilotProposeTool(env).execute!(await poInput(env, 120), {}));
    await env.decide(out.proposal_id, approver, { decision: 'reject', reason: 'not now' });
    expect(env.queue.sent).toHaveLength(0);
    expect((await env.harness.get(out.proposal_id)).status).toBe('rejected');
  });

  test('auto-approved run-less proposal (Copilot) executes immediately', async () => {
    env = await mcpEnv();
    const before = await purchaseCount(env);
    const out = ToolOut.parse(await copilotProposeTool(env).execute!(await poInput(env, 10), {}));
    expect(out.status).toBe('auto_approved');
    expect((await env.harness.get(out.proposal_id)).status).toBe('executed');
    expect(await purchaseCount(env)).toBe(before + 1);
  });

  test('MCP decide_proposal triggers execution', async () => {
    env = await mcpEnv();
    const writer = await env.connect(await env.tokenWith('Claude Code', ['propose']));
    const proposed = z.object({ proposalId: z.string(), status: z.string() }).parse(
      resultOf(await writer.callTool({ name: 'propose_distru_purchases_upsert', arguments: { intent: 'Restock Blue Dream from Claude Code', ...(await poInput(env, 150)) } })),
    );
    expect(proposed.status).toBe('pending_approval');
    const approverClient = await env.connect(await env.tokenWith('Approver bot', ['approve']));
    const decided = await approverClient.callTool({ name: 'decide_proposal', arguments: { intent: 'Matches plan', id: proposed.proposalId, decision: 'approve' } });
    expect(decided.isError).toBeFalsy();
    expect(env.queue.sent).toEqual([proposed.proposalId]);
    expect((await env.harness.get(proposed.proposalId)).status).toBe('executed');
  });
});

describe('afterDecision with a workflow run', () => {
  const approvedWithRun = (status: Proposal['status'] = 'approved'): Proposal => ({
    id: 'p-1',
    version: 2,
    status,
    title: null,
    rationale: null,
    meta: { workflowRunId: 'run-1', workflowId: 'restock' },
    createdBy: agentPrincipal('procurement-planner'),
    createdAt: '2026-11-19T12:00:00Z',
    updatedAt: '2026-11-19T12:00:00Z',
    ops: [],
    policy: { outcome: 'needs_approval', reasons: [] },
    decision: { decision: 'approve', by: approver, reason: null, edited: false, at: '2026-11-19T12:00:00Z' },
    execution: null,
  });

  const hook = (runs: DecisionRuns) => {
    const sent: string[] = [];
    return { sent, run: afterDecision({ runs, send: async (id) => void sent.push(id) }) };
  };

  test('a suspended run is resumed (it executes); nothing queued', async () => {
    const h = hook({ resume: async () => true, status: async () => 'suspended' });
    await h.run(approvedWithRun());
    expect(h.sent).toEqual([]);
  });

  test('a run still going reads the decision itself; a finished or missing run → queued', async () => {
    const running = hook({ resume: async () => false, status: async () => 'running' });
    await running.run(approvedWithRun());
    expect(running.sent).toEqual([]);
    const finished = hook({ resume: async () => false, status: async () => 'failed' });
    await finished.run(approvedWithRun());
    expect(finished.sent).toEqual(['p-1']);
    const gone = hook({ resume: async () => false, status: async () => null });
    await gone.run(approvedWithRun());
    expect(gone.sent).toEqual(['p-1']);
    // Already executing/executed (second click): nothing.
    const again = hook({ resume: async () => false, status: async () => null });
    await again.run(approvedWithRun('executed'));
    expect(again.sent).toEqual([]);
  });
});

describe('proposal-execute body', () => {
  test('one durable step per op; a replay with the same step results writes nothing', async () => {
    env = await mcpEnv();
    const steps = new MemoStepRunner();
    const harness = createHarness({ registry: env.registry, store: env.store, audit: env.audit, policyRules: { list: async () => [] }, steps });
    const p = await env.harness.propose({ ctx: env.distru, principal: agentPrincipal('script'), ops: [{ action: 'distru.purchases.upsert', input: await poInput(env, 100) }] });
    await env.harness.decide({ ctx: env.distru, principal: approver, proposalId: p.id, decision: 'approve' });
    const before = await purchaseCount(env);
    expect((await executeApprovedProposal(harness, env.distru, p.id)).status).toBe('executed');
    expect(steps.calls).toEqual([stepIds.start(p.id), stepIds.op(p.id, 0), stepIds.finish(p.id)]);
    expect((await executeApprovedProposal(harness, env.distru, p.id)).status).toBe('executed');
    expect(await purchaseCount(env)).toBe(before + 1);
  });
});
