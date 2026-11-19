/**
 * Undo of the executed cross-tool restock proposal (scripted models, everything in-process):
 * harness.undo → a NEW pending proposal (reverse order) → approve (another approver) → execute:
 * receiving tasks deleted, buyer cap restored (get-product), POs deleted (never received),
 * vendor emails listed as not undoable. Also: the proposal detail's `undo` block.
 */
import { describe, expect, test } from 'bun:test';
import { DistruApiError } from '@ops/distru-client';
import { userPrincipal, type Proposal } from '@ops/harness';
import { z } from 'zod';
import { CAP_ACTION, EMAIL_ACTION, PURCHASE_ACTION, TASK_ACTION } from '../src/mastra/workflows/cross-tool';
import { RestockResultSchema } from '../src/mastra/workflows/restock';
import { resumeRunOnDecision } from '../src/services/runs';
import { toProposalDetail } from '../src/services/proposals';
import { restockEnv, type RestockEnv } from './fixtures/restock-env';

const SCOPE_SKUS = ['VAP-BD-1G', 'PRE-BD-1G', 'FLW-OGK-35', 'FLW-BD-35'];
const operator = userPrincipal('u-operator', 'operator', 'Olly Operator');
const approver2 = userPrincipal('u-approver-2', 'approver', 'Bea Approver');

async function executedRestock(env: RestockEnv): Promise<{ p: Proposal; ids: Record<string, string> }> {
  const oakland = (await env.locations()).find((l) => l.name.startsWith('Oakland'))!;
  const ids = Object.fromEntries(await Promise.all(SCOPE_SKUS.map(async (sku) => [sku, await env.productId(sku)] as const)));
  const { runId } = await env.launcher.start({ triggeredBy: 'test', locationIds: [oakland.id], productIds: Object.values(ids) });
  await env.waitFor(runId, ['suspended']);
  const pending = (await env.findProposalByRunId(runId))!;
  const decided = await env.harness.decide({ ctx: env.contexts.read, principal: env.approver, proposalId: pending.id, decision: 'approve', reason: 'ok' });
  await resumeRunOnDecision(env.launcher)(decided);
  const done = await env.waitFor(runId, ['success'], 30_000);
  expect(RestockResultSchema.parse(done.result).status).toBe('executed');
  return { p: await env.harness.get(pending.id), ids };
}

const gone = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return false;
  } catch (err) {
    return err instanceof DistruApiError && err.isNotFound;
  }
};

const capOf = async (env: RestockEnv, productId: string) => {
  const planner = { kind: 'agent' as const, id: 'procurement-planner', scopes: ['read' as const] };
  const out = await env.connectors.registry.runReadTool(env.contexts.read, planner, 'distru_mcp.get_product', { id: productId });
  return z.object({ product: z.object({ maxMenuBuyerOrderQuantity: z.number().nullable() }).passthrough() }).parse(out).product.maxMenuBuyerOrderQuantity;
};

describe('undo the cross-tool restock proposal', () => {
  test('PO deleted, cap restored, task deleted, email listed as not undoable; nothing written until the undo is approved', async () => {
    const env = await restockEnv();
    const { p, ids } = await executedRestock(env);
    const pos = p.ops.filter((op) => op.action === PURCHASE_ACTION);
    const tasks = p.ops.filter((op) => op.action === TASK_ACTION);
    const emails = p.ops.filter((op) => op.action === EMAIL_ACTION);
    const caps = p.ops.filter((op) => op.action === CAP_ACTION);
    expect(await capOf(env, ids['VAP-BD-1G']!)).toBe(25);

    // Preview (what the proposal detail shows).
    const info = await env.harness.undoInfo(p.id);
    expect(info.available).toBe(true);
    for (const op of [...pos, ...tasks, ...caps]) expect(info.ops[op.index]).toMatchObject({ canUndo: true, reason: null });
    for (const op of emails) expect(info.ops[op.index]).toMatchObject({ canUndo: false, reason: expect.stringContaining('cannot be unsent') });
    const detail = toProposalDetail(p, info);
    expect(detail.undo.available).toBe(true);

    // The undo is a NEW proposal: reverse op order, needs approval (never auto-approved), nothing written yet.
    const writes = { po: env.net.purchaseWrites, tasks: env.net.taskWrites, mail: env.outbox.deliveries };
    const u = await env.harness.undo({ ctx: env.contexts.read, principal: operator, proposalId: p.id, reason: 'Vendor cannot deliver this month' });
    expect(u.status).toBe('pending_approval');
    expect(u.meta.undoOf).toEqual({ proposalId: p.id, opIndexes: [...pos, ...tasks, ...caps].map((o) => o.index).sort((a, b) => b - a) });
    expect(z.array(z.object({ opIndex: z.number(), reason: z.string() })).parse(u.meta.notUndoable).map((n) => n.opIndex).sort()).toEqual(emails.map((o) => o.index).sort());
    const order = u.ops.map((o) => z.object({ undoOf: z.object({ opIndex: z.number() }) }).parse(o.input).undoOf.opIndex);
    expect(order).toEqual([...order].sort((a, b) => b - a));
    const capUndo = u.ops.find((o) => o.action === `${CAP_ACTION}.undo`)!;
    expect(capUndo.diff).toEqual([{ path: ['maxMenuBuyerOrderQuantity'], kind: 'changed', before: 25, after: null }]);
    expect(u.ops.filter((o) => o.action === `${PURCHASE_ACTION}.undo`).every((o) => /^Delete PO-\d+ \(PENDING, never received\)/.test(o.summary ?? ''))).toBe(true);
    expect(u.policy.reasons.some((r) => r.rule === 'undo_requires_approval')).toBe(true);
    expect({ po: env.net.purchaseWrites, tasks: env.net.taskWrites, mail: env.outbox.deliveries }).toEqual(writes);
    expect(await capOf(env, ids['VAP-BD-1G']!)).toBe(25);

    // The operator who asked cannot approve; another approver does; the executor applies it.
    await expect(env.harness.decide({ ctx: env.contexts.read, principal: operator, proposalId: u.id, decision: 'approve' })).rejects.toThrow(/approve/);
    await env.harness.decide({ ctx: env.contexts.read, principal: approver2, proposalId: u.id, decision: 'approve' });
    const undone = await env.harness.execute({ ctx: env.contexts.execute, proposalId: u.id });
    expect(undone.status).toBe('executed');
    expect(undone.ops.every((o) => o.status === 'executed' && o.result?.mismatches.length === 0)).toBe(true);

    const distru = env.contexts.read.connectors.distru;
    for (const t of tasks) expect(await gone(() => distru.getTask(t.result!.recordId!))).toBe(true);
    for (const po of pos) expect(await gone(() => distru.getPurchase(po.result!.recordId!))).toBe(true);
    expect(await capOf(env, ids['VAP-BD-1G']!)).toBeNull();
    expect(env.outbox.deliveries).toBe(3); // emails stay sent

    // The original now shows every undoable op as covered by the executed undo.
    const after = await env.harness.undoInfo(p.id);
    expect(after.available).toBe(false);
    expect(after.undoProposalId).toBe(u.id);
    expect(env.audit.ofType('proposal.undo_proposed').find((e) => e.proposalId === p.id)!.data.undoProposalId).toBe(u.id);
  }, 60_000);
});
