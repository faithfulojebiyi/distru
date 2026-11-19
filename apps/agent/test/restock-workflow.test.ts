/**
 * The restock workflow end to end with scripted (mock) models: no network, no LLM, no API key.
 * Runs against the in-process Distru mock and an in-memory harness on Mastra's default engine
 * (the same steps the server runs on Inngest).
 */
import { describe, expect, test } from 'bun:test';
import { ForbiddenError, PrincipalSchema, type Proposal } from '@ops/harness';
import { z } from 'zod';
import { AGENT_KEYS, AGENTS, principalFor } from '../src/mastra/agents/roster';
import { toolDescriptorsFor } from '../src/mastra/tools/harness-tools';
import { VetoedLineSchema, RestockResultSchema } from '../src/mastra/workflows/restock';
import { appRegistry } from '../src/harness/registry';
import { createRunsService, harnessProposalLinks, resumeRunOnDecision } from '../src/services/runs';
import { FAILED_TEST_SKU, INJECTION_SKU, restockEnv, type RestockEnv } from './fixtures/restock-env';

const Meta = z.object({
  workflowRunId: z.string(),
  vetoedLines: z.array(VetoedLineSchema),
  suspiciousText: z.array(z.object({ sku: z.string().nullable(), source: z.string() })),
  revisions: z.number(),
  critiques: z.array(z.object({ round: z.number(), explanation: z.string() })),
});

const LinesInput = z.object({ vendor_id: z.string(), location_id: z.string(), lines: z.array(z.object({ product_id: z.string(), quantity: z.number(), unit_price: z.number() })) });
const linesOf = (p: Proposal) => p.ops.flatMap((op) => LinesInput.parse(op.input).lines);

async function la(env: RestockEnv) {
  const locs = await env.locations();
  return locs.find((l) => l.name.startsWith('Los Angeles'))!;
}

/** LA, scoped to the failed-lab-test SKU, the prompt-injection SKU and one clean SKU. */
async function defaultScope(env: RestockEnv) {
  const [wc, pe, bd] = await Promise.all([env.productId(FAILED_TEST_SKU), env.productId(INJECTION_SKU), env.productId('FLW-BD-35')]);
  return { ids: { wc, pe, bd }, trigger: { triggeredBy: 'test', locationIds: [(await la(env)).id], productIds: [wc, pe, bd] } };
}

async function start(env: RestockEnv, trigger: Parameters<RestockEnv['launcher']['start']>[0]) {
  const { runId } = await env.launcher.start(trigger);
  return runId;
}

describe('restock workflow (scripted models, in-process mock)', () => {
  test('default scenario: FLW-WC-35 vetoed, VAP-PE-1G injection flagged and not obeyed, suspends for approval', async () => {
    const env = restockEnv();
    const { ids, trigger } = await defaultScope(env);
    const runId = await start(env, trigger);
    const state = await env.waitFor(runId, ['suspended']);

    const proposal = await env.findProposalByRunId(runId);
    expect(proposal).not.toBeNull();
    const p = proposal!;
    expect(p.status).toBe('pending_approval');
    expect(p.createdBy).toMatchObject({ kind: 'agent', id: AGENTS.procurementPlanner.id });
    const meta = Meta.parse(p.meta);
    expect(meta.workflowRunId).toBe(runId);

    // Compliance: the failed lab test SKU is vetoed (by the Reviewer and the deterministic check) and not ordered.
    const lines = linesOf(p);
    expect(lines.some((l) => l.product_id === ids.wc)).toBe(false);
    const veto = meta.vetoedLines.find((v) => v.product_id === ids.wc);
    expect(veto?.source).toBe('both');
    expect(veto?.reasons.join(' ')).toContain('lab test failed');

    // Injection: flagged as suspicious, never obeyed.
    expect(meta.suspiciousText.some((s) => s.sku === INJECTION_SKU && s.source === 'distru.product.description')).toBe(true);
    const pe = lines.find((l) => l.product_id === ids.pe)!;
    expect(pe).toBeDefined();
    expect(pe.quantity).toBeLessThan(5000);
    expect(lines.every((l) => l.quantity < 5000)).toBe(true);

    // One proposal, one op per vendor/location; suspended on await-decision with the proposal id.
    expect(p.ops.length).toBe(2);
    expect(state.steps?.['await-decision']).toMatchObject({ status: 'suspended', suspendPayload: { proposalId: p.id } });
    expect(env.net.purchaseWrites).toBe(0);
    expect(p.rationale).toContain('Vetoed lines');
  });

  test('suspension → approve → resume → PO created and verified → re-running execute writes nothing', async () => {
    const env = restockEnv();
    const { trigger } = await defaultScope(env);
    const runId = await start(env, trigger);
    await env.waitFor(runId, ['suspended']);
    const p = (await env.findProposalByRunId(runId))!;

    const decided = await env.harness.decide({ ctx: env.contexts.read, principal: env.approver, proposalId: p.id, decision: 'approve', reason: 'ok' });
    const resume = resumeRunOnDecision(env.launcher);
    await resume(decided);
    await resume(decided); // a second click / retried request: no-op
    const done = await env.waitFor(runId, ['success']);

    const result = RestockResultSchema.parse(done.result);
    expect(result.status).toBe('executed');
    expect(result.verified).toBe(true);
    expect(result.purchaseOrderIds).toHaveLength(2);
    expect(env.net.purchaseWrites).toBe(2);
    const state = await (await env.mock.app.request('/__mock/state')).json();
    expect(z.object({ counts: z.object({ purchases: z.number() }) }).parse(state).counts.purchases).toBeGreaterThan(0);

    const executed = await env.harness.get(p.id);
    expect(executed.status).toBe('executed');
    expect(env.audit.types(p.id)).toEqual(expect.arrayContaining(['proposal.created', 'proposal.decided', 'op.executed', 'op.verified']));

    // Idempotent: executing again (a replayed step) skips executed ops; no new writes.
    await env.harness.execute({ ctx: env.contexts.execute, proposalId: p.id });
    expect(env.net.purchaseWrites).toBe(2);
    // ...and a resume after completion is a no-op.
    expect(await env.launcher.resumeAfterDecision(runId, { decision: 'approve' })).toBe(false);
  });

  test('reject path: run ends rejected, nothing written', async () => {
    const env = restockEnv();
    const { trigger } = await defaultScope(env);
    const runId = await start(env, trigger);
    await env.waitFor(runId, ['suspended']);
    const p = (await env.findProposalByRunId(runId))!;
    const decided = await env.harness.decide({ ctx: env.contexts.read, principal: env.approver, proposalId: p.id, decision: 'reject', reason: 'not now' });
    await resumeRunOnDecision(env.launcher)(decided);
    const done = await env.waitFor(runId, ['success']);
    expect(RestockResultSchema.parse(done.result)).toMatchObject({ status: 'rejected', purchaseOrderIds: [] });
    expect(env.net.purchaseWrites).toBe(0);
    expect((await env.harness.get(p.id)).status).toBe('rejected');
  });

  test('auto-approve path: a medium-risk PO under $500 executes without a human', async () => {
    const env = restockEnv({ planner: { quantity: () => 5 } });
    const bd = await env.productId('FLW-BD-35');
    const runId = await start(env, { triggeredBy: 'test', locationIds: [(await la(env)).id], productIds: [bd] });
    const done = await env.waitFor(runId, ['success']);
    const result = RestockResultSchema.parse(done.result);
    expect(result.status).toBe('executed');
    expect(result.totalValue!).toBeLessThan(500);
    const p = (await env.harness.get(result.proposalId!))!;
    expect(p.status).toBe('executed');
    expect(p.policy.outcome).toBe('allow');
    expect(p.ops[0]!.risk).toBe('medium');
    expect(p.decision).toBeNull();
    expect(env.net.purchaseWrites).toBe(1);
    // never suspended
    expect(done.steps?.['await-decision']).toMatchObject({ status: 'success' });
  });

  test('revision path: a tiny max_total_value denies the plan → Policy Critic → Planner revises → within cap', async () => {
    const env = restockEnv({
      rules: [
        { key: 'max_total_value', params: { max: 300 } },
        { key: 'allowed_actions', params: { actions: ['distru.purchases.upsert'] } },
      ],
      planner: { revise: 'shrink' },
    });
    const { trigger } = await defaultScope(env);
    const runId = await start(env, trigger);
    const state = await env.waitFor(runId, ['suspended', 'success']);
    const p = (await env.findProposalByRunId(runId))!;
    const meta = Meta.parse(p.meta);
    expect(meta.revisions).toBeGreaterThanOrEqual(1);
    expect(meta.critiques[0]?.explanation).toContain('max_total_value');
    expect(p.policy.outcome).not.toBe('deny');
    expect(p.ops.reduce((s, op) => s + (op.value ?? 0), 0)).toBeLessThanOrEqual(300);
    expect(state.status).toBe('suspended');

    // Timeline: Policy Critic and the Planner's revision appear on review-round.
    const runs = createRunsService({ launcher: env.launcher, proposalLinks: harnessProposalLinks(env.findProposalByRunId) });
    const detail = (await runs.get(runId))!;
    const review = detail.steps.find((s) => s.stepId === 'review-round')!;
    expect(review.agents.map((a) => a.agent)).toEqual(expect.arrayContaining(['compliance-reviewer', 'policy-critic', 'procurement-planner']));
    expect(review.agents.find((a) => a.agent === 'procurement-planner')?.label).toContain('revision 1');
  });

  test('injection obeyed by the Planner is caught by the plan guard and revised away', async () => {
    const env = restockEnv({ planner: { obeyInjection: true, revise: 'suggested' } });
    const { ids, trigger } = await defaultScope(env);
    const runId = await start(env, trigger);
    await env.waitFor(runId, ['suspended']);
    const p = (await env.findProposalByRunId(runId))!;
    const meta = Meta.parse(p.meta);
    expect(meta.revisions).toBe(1);
    expect(meta.critiques[0]?.explanation).toContain('plan_guard');
    const pe = linesOf(p).find((l) => l.product_id === ids.pe)!;
    expect(pe.quantity).toBeLessThan(5000);
    expect(meta.suspiciousText.some((s) => s.sku === INJECTION_SKU)).toBe(true);
  });

  test('GET /api/runs data: list + detail timeline with agents, tokens, cost, tool calls and the linked proposal', async () => {
    const env = restockEnv();
    const { trigger } = await defaultScope(env);
    const runId = await start(env, trigger);
    await env.waitFor(runId, ['suspended']);
    const runs = createRunsService({ launcher: env.launcher, proposalLinks: harnessProposalLinks(env.findProposalByRunId) });

    const list = await runs.list({ limit: 10 });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ runId, status: 'suspended', triggeredBy: 'test', proposal: { status: 'pending_approval' } });

    const detail = (await runs.get(runId))!;
    expect(detail.status).toBe('suspended');
    expect(detail.suspendPayload).toMatchObject({ proposalId: list[0]!.proposal!.id });
    const stepIds = detail.steps.map((s) => s.stepId);
    expect(stepIds).toEqual(expect.arrayContaining(['prepare', 'analyse-location', 'merge-at-risk', 'plan-vendor', 'collect-plan', 'review-round', 'propose', 'await-decision']));
    const analyse = detail.steps.find((s) => s.stepId === 'analyse-location')!;
    expect(analyse.agents[0]).toMatchObject({ agent: 'inventory-analyst', status: 'success' });
    expect(analyse.agents[0]!.toolCalls.map((t) => t.tool)).toContain('distru_velocity_report');
    expect(analyse.agents[0]!.tokens.total).toBeGreaterThan(0);
    const plan = detail.steps.find((s) => s.stepId === 'plan-vendor')!;
    expect(plan.agents).toHaveLength(3); // one Planner per vendor, in parallel
    expect(plan.iterations).toBe(3);
    expect(detail.steps.find((s) => s.stepId === 'merge-at-risk')!.iterations).toBeNull();
    expect(plan.agents.flatMap((a) => a.toolCalls.map((t) => t.tool))).toContain('propose_distru_purchases_upsert');
    expect(detail.totals.agentCalls).toBe(1 + 3 + 1);
    expect(detail.totals.costUsd).toBeGreaterThan(0);
  });
});

describe('agent scopes', () => {
  test('no agent can approve: no approve/decide tool, principals refuse the scope, harness.decide rejects agents', async () => {
    for (const key of AGENT_KEYS) {
      const principal = principalFor(key);
      expect(principal.scopes).not.toContain('approve');
      const names = toolDescriptorsFor(appRegistry, key).map((d) => d.toolName);
      expect(names.some((n) => /approve|decide|execute/.test(n))).toBe(false);
      const proposes = names.filter((n) => n.startsWith('propose_'));
      expect(proposes.length > 0).toBe(key === 'procurementPlanner');
    }
    expect(() => PrincipalSchema.parse({ kind: 'agent', id: 'x', scopes: ['read', 'approve'] })).toThrow();

    const env = restockEnv();
    const tools = Object.keys((await env.agents.opsLead.listTools()) ?? {});
    expect(tools).toContain('start_restock_run');
    expect(tools.some((n) => /approve|decide|propose_/.test(n))).toBe(false);
    for (const agent of [env.agents.inventoryAnalyst, env.agents.complianceReviewer, env.agents.policyCritic]) {
      expect(Object.keys(await agent.listTools()).some((n) => n.startsWith('propose_') || /approve/.test(n))).toBe(false);
    }
    expect(Object.keys(await env.agents.procurementPlanner.listTools())).toContain('propose_distru_purchases_upsert');

    // Even a hand-built agent principal that claims approve is refused by the harness.
    const { trigger } = await defaultScope(env);
    const runId = await start(env, trigger);
    await env.waitFor(runId, ['suspended']);
    const p = (await env.findProposalByRunId(runId))!;
    const rogue = { kind: 'agent' as const, id: 'ops-lead', scopes: ['read' as const, 'propose' as const, 'approve' as const] };
    await expect(env.harness.decide({ ctx: env.contexts.read, principal: rogue, proposalId: p.id, decision: 'approve' })).rejects.toBeInstanceOf(ForbiddenError);
  });

  test('propose tool outside a workflow creates a pending proposal and never writes to Distru', async () => {
    const env = restockEnv();
    const tools = await env.agents.procurementPlanner.listTools();
    const tool = tools['propose_distru_purchases_upsert'];
    expect(tool?.execute).toBeDefined();
    const loc = await la(env);
    const bd = await env.productId('FLW-BD-35');
    const vendor = z.object({ vendor: z.object({ id: z.string() }) }).parse(await appRegistry.runReadTool(env.contexts.read, principalFor('procurementPlanner'), 'distru.products_get', { product_id: bd }));
    const out = await tool!.execute!({ vendor_id: vendor.vendor.id, location_id: loc.id, lines: [{ product_id: bd, quantity: 48, unit_price: 14 }] }, {});
    expect(out).toMatchObject({ ok: true, mode: 'proposal', status: 'pending_approval' });
    expect(env.net.purchaseWrites).toBe(0);
    // Schema-invalid input is rejected by Mastra's tool validation; plan-time errors come back as ok=false.
    expect(await tool!.execute!({ vendor_id: 'v', location_id: loc.id, lines: [] }, {})).toMatchObject({ error: true });
    const missing = await tool!.execute!({ vendor_id: vendor.vendor.id, location_id: loc.id, purchase_id: 'no-such-po', lines: [{ product_id: bd, quantity: 1, unit_price: 1 }] }, {});
    expect(missing).toMatchObject({ ok: false, validation: true });
    expect(env.net.purchaseWrites).toBe(0);
  });
});
