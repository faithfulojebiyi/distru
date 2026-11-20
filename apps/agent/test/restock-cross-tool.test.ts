/**
 * The cross-tool restock end to end (scripted models, everything in-process): Headset retail blend in
 * the Analyst, allocation guard (Distru MCP `mutate_product` buyer cap), vendor emails and receiving
 * tasks referencing their PO via `{{op:N.…}}`, one proposal, approve → execute in order → verify →
 * idempotent re-run; failure mid-way → failed + resumable; boot in degraded mode without the MCP server.
 */
import { describe, expect, test } from 'bun:test';
import { McpBridgeClient } from '@ops/connector-mcp';
import { DistruApiError } from '@ops/distru-client';
import type { Proposal } from '@ops/harness';
import { z } from 'zod';
import { AppConnectors, appErrorClassifier, buildAppRegistry, DISTRU_MCP_ID } from '../src/harness/registry';
import { AtRiskSkuSchema } from '../src/mastra/agents/inventory-analyst';
import { toolDescriptorsFor } from '../src/mastra/tools/harness-tools';
import { CAP_ACTION, computeCap, EMAIL_ACTION, PURCHASE_ACTION, TASK_ACTION } from '../src/mastra/workflows/cross-tool';
import { RestockResultSchema } from '../src/mastra/workflows/restock';
import { createConnectorsService } from '../src/services/connectors';
import { resumeRunOnDecision } from '../src/services/runs';
import { restockEnv, type RestockEnv } from './fixtures/restock-env';

const SCOPE_SKUS = ['VAP-BD-1G', 'PRE-BD-1G', 'FLW-OGK-35', 'FLW-BD-35'];

async function oaklandScope(env: RestockEnv) {
  const oakland = (await env.locations()).find((l) => l.name.startsWith('Oakland'))!;
  const ids = Object.fromEntries(await Promise.all(SCOPE_SKUS.map(async (sku) => [sku, await env.productId(sku)] as const)));
  return { ids, trigger: { triggeredBy: 'test', locationIds: [oakland.id], productIds: Object.values(ids) } };
}

async function suspendedProposal(env: RestockEnv): Promise<{ runId: string; p: Proposal; ids: Record<string, string> }> {
  const { ids, trigger } = await oaklandScope(env);
  const { runId } = await env.launcher.start(trigger);
  await env.waitFor(runId, ['suspended']);
  return { runId, p: (await env.findProposalByRunId(runId))!, ids };
}

async function approveAndFinish(env: RestockEnv, runId: string, p: Proposal) {
  const decided = await env.harness.decide({ ctx: env.contexts.read, principal: env.approver, proposalId: p.id, decision: 'approve', reason: 'ok' });
  await resumeRunOnDecision(env.launcher)(decided);
  const done = await env.waitFor(runId, ['success'], 30_000);
  return RestockResultSchema.parse(done.result);
}

const mcpWrites = (env: RestockEnv) => env.connectors.mcpClient().calls.filter((c) => c.name === 'distru-mutate-product').length;

const EmailPayload = z.object({ to: z.array(z.string()), subject: z.string(), text: z.string() });
const TaskPayload = z.object({ name: z.string(), purchase_id: z.string(), owner_id: z.string(), due_datetime: z.string() });
const CapPayload = z.object({ action: z.literal('UPDATE'), id: z.string(), maxMenuBuyerOrderQuantity: z.number() });

describe('Inventory Analyst: wholesale × retail blend', () => {
  test('FLW-OGK-35 surfaces as "watch" from retail although Distru says OK; Blue Dream cart/pre-roll are surging', async () => {
    const env = await restockEnv();
    const { runId, ids } = await suspendedProposal(env);
    const state = await env.launcher.workflow().getWorkflowRunById(runId);
    const merged = z.object({ output: z.array(z.object({ vendor: z.object({ name: z.string() }), items: z.array(AtRiskSkuSchema) })) }).parse(state!.steps!['merge-at-risk']).output;
    const items = merged.flatMap((v) => v.items);
    const bySku = (sku: string) => items.find((i) => i.product_id === ids[sku])!;

    const ogk = bySku('FLW-OGK-35');
    expect(ogk).toMatchObject({ reorder_status: 'OK', recommendation: 'watch', retail_signal: 'surging', flagged_by: 'retail' });
    expect(ogk.adjusted_days_of_supply!).toBeLessThan(ogk.days_of_supply!);
    expect(ogk.reason).toContain('Distru:');
    expect(ogk.reason).toContain('Headset:');
    expect(bySku('VAP-BD-1G')).toMatchObject({ retail_signal: 'surging', recommendation: 'reorder_now', flagged_by: 'both' });
    expect(bySku('PRE-BD-1G')).toMatchObject({ retail_signal: 'surging' });

    // The Analyst's tools now include the retail blend (and nothing that writes).
    const tools = toolDescriptorsFor(env.connectors.registry, 'inventoryAnalyst').map((d) => d.toolName);
    expect(tools).toEqual(expect.arrayContaining(['headset_retail_trends', 'headset_demand_signal', 'distru_velocity_report']));
    expect(tools.some((t) => t.startsWith('propose_'))).toBe(false);
  });
});

describe('cross-tool proposal: PO → buyer cap → vendor email → receiving task', () => {
  test('one proposal, ordered per PO, placeholders in the diff, always needs a human (email is high risk)', async () => {
    const env = await restockEnv();
    const { p, ids } = await suspendedProposal(env);
    expect(p.status).toBe('pending_approval');
    expect(p.policy.reasons.some((r) => r.rule === 'high_risk_requires_approval' && r.outcome === 'needs_approval')).toBe(true);
    expect(p.policy.reasons.find((r) => r.rule === 'email_recipient_domains')?.outcome).toBe('pass');
    expect(p.policy.reasons.find((r) => r.rule === 'max_total_value')?.outcome).toBe('pass'); // emails/tasks/caps count as $0

    // Order: each PO is followed by its caps, then its email, then its task, which reference it by index.
    const pos = p.ops.filter((op) => op.action === PURCHASE_ACTION);
    expect(pos.length).toBe(3);
    for (const po of pos) {
      const next = pos.find((q) => q.index > po.index)?.index ?? p.ops.length;
      const group = p.ops.slice(po.index + 1, next);
      const actions = group.map((op) => op.action);
      expect(actions.filter((a) => a === EMAIL_ACTION)).toHaveLength(1);
      expect(actions.filter((a) => a === TASK_ACTION)).toHaveLength(1);
      expect(actions.lastIndexOf(CAP_ACTION)).toBeLessThan(actions.indexOf(EMAIL_ACTION));
      expect(actions.indexOf(EMAIL_ACTION)).toBeLessThan(actions.indexOf(TASK_ACTION));
      const email = EmailPayload.parse(group.find((op) => op.action === EMAIL_ACTION)!.payload);
      expect(email.subject).toContain(`{{op:${po.index}.purchase_number}}`);
      expect(email.text).toContain(`{{op:${po.index}.purchase_number}}`);
      const task = TaskPayload.parse(group.find((op) => op.action === TASK_ACTION)!.payload);
      expect(task.purchase_id).toBe(`{{op:${po.index}.recordId}}`);
      expect(task.name).toMatch(new RegExp(`^Receive \\{\\{op:${po.index}\\.purchase_number\\}\\} on \\d{4}-\\d{2}-\\d{2}$`));
    }

    // Allocation guard: one cap per SKU that stocks out (company-wide) before its PO arrives, exactly the
    // computed suggestion, placed right after its PO. VAP-BD-1G (~5 adjusted days < 14-day Sierra lead time) is one.
    const caps = p.ops.filter((op) => op.action === CAP_ACTION);
    const guard = z.array(z.object({ product_id: z.string(), cap: z.number(), available: z.number(), active_buyers: z.number(), units_per_case: z.number().nullable(), status: z.string() })).parse(p.meta.allocationGuard);
    const placed = guard.filter((g) => g.status !== 'dropped: not ordered');
    expect(caps.length).toBe(placed.length);
    expect(placed.map((g) => g.product_id)).toContain(ids['VAP-BD-1G']!);
    for (const op of caps) {
      const cap = CapPayload.parse(op.payload);
      const g = placed.find((x) => x.product_id === cap.id)!;
      expect(cap.maxMenuBuyerOrderQuantity).toBe(g.cap);
      expect(g.cap).toBe(computeCap(g.available, g.active_buyers, g.units_per_case));
      expect(op.diff).toEqual([{ path: ['maxMenuBuyerOrderQuantity'], kind: 'changed', before: null, after: g.cap }]);
      expect(op.risk).toBe('medium');
      const po = pos.filter((x) => x.index < op.index).at(-1)!;
      expect(z.object({ lines: z.array(z.object({ product_id: z.string() })) }).parse(po.input).lines.some((l) => l.product_id === cap.id)).toBe(true);
    }
    // VAP-BD-1G: whole cases of 25, at least one case.
    expect(CapPayload.parse(caps.find((op) => CapPayload.parse(op.payload).id === ids['VAP-BD-1G'])!.payload).maxMenuBuyerOrderQuantity).toBe(25);
    // The cap is company-wide, so its trigger and its share are company-wide numbers.
    expect(p.rationale).toContain('company-wide adjusted days of supply');
    expect(p.rationale).toMatch(/\d+ available company-wide ÷ \d+ active buyer/);
    expect(p.rationale).toContain('Allocation guard');
    // Short title (three vendors: the code template), the detail in summary.
    expect(p.title).toBe('Restock 3 vendors · Oakland Warehouse');
    // The summary is one human sentence that does not repeat the title.
    expect(p.summary).toMatch(new RegExp(`^3 purchase orders worth \\$[\\d,.]+ across three vendors for Oakland Warehouse, with ${caps.length} buyer caps?, 3 vendor emails and 3 receiving tasks\\.$`));
    // The rationale is the agents' reasoning (answer table, per vendor), not the trigger line.
    expect(p.rationale).not.toContain('Triggered by');
    expect(p.rationale).toContain('| Vendor | SKU | Location |');
    expect(p.meta).toMatchObject({ titleSource: 'template', titleRejectedReason: 'no single agent headline for this proposal' });

    // Nothing written while proposing.
    expect(env.net.purchaseWrites + env.net.taskWrites + mcpWrites(env) + env.outbox.deliveries).toBe(0);
  });

  test('approve → executes every op in order → each verified (cap read back via get-product) → re-execute writes nothing', async () => {
    const env = await restockEnv();
    const { runId, p, ids } = await suspendedProposal(env);
    const result = await approveAndFinish(env, runId, p);
    expect(result).toMatchObject({ status: 'executed', verified: true });
    expect(result.purchaseOrderIds).toHaveLength(3);
    expect(result.emailIds).toHaveLength(3);
    expect(result.taskIds).toHaveLength(3);
    expect(result.buyerCapProductIds.length).toBe(p.ops.filter((op) => op.action === CAP_ACTION).length);
    expect(result.buyerCapProductIds).toContain(`prd_${ids['VAP-BD-1G']!}`); // MCP record ids are prefixed

    const done = await env.harness.get(p.id);
    expect(done.status).toBe('executed');
    expect(done.ops.every((op) => op.status === 'executed' && op.result?.mismatches.length === 0)).toBe(true);
    // Executed strictly in op order.
    const executed = env.audit.ofType('op.executed').filter((e) => e.proposalId === p.id).map((e) => e.data.opIndex);
    expect(executed).toEqual(done.ops.map((op) => op.index));
    expect(env.audit.ofType('op.verified').filter((e) => e.proposalId === p.id)).toHaveLength(done.ops.length);

    // Each email went out once, to the vendor, with the real PO number; the op result records the substitution.
    const sent = await env.outbox.list(50);
    expect(sent).toHaveLength(3);
    for (const po of done.ops.filter((op) => op.action === PURCHASE_ACTION)) {
      const poNumber = String(po.result!.outputs!.purchase_number);
      expect(poNumber).toMatch(/^PO-\d+$/);
      const email = done.ops.find((op) => op.action === EMAIL_ACTION && Object.values(op.result?.resolved ?? {}).includes(poNumber))!;
      expect(email.result!.resolved).toEqual({ [`{{op:${po.index}.purchase_number}}`]: poNumber, [`{{op:${po.index}.recordId}}`]: po.result!.recordId });
      const message = sent.find((m) => m.messageId === email.result!.recordId)!;
      expect(message.subject).toContain(poNumber);
      expect(message.text).toContain(poNumber);
      expect(message.text).not.toContain('{{op:');

      // The receiving task is linked to the PO and assigned to the purchasing user.
      const taskOp = done.ops.find((op) => op.action === TASK_ACTION && op.result?.resolved?.[`{{op:${po.index}.recordId}}`] === po.result!.recordId)!;
      const task = (await env.contexts.read.connectors.distru.getTask(taskOp.result!.recordId!)).data!;
      expect(task.purchase).toMatchObject({ id: po.result!.recordId, purchase_number: poNumber });
      expect(task.name).toStartWith(`Receive ${poNumber} on `);
      expect(task.owner?.full_name).toBe('Sam Rivera');
    }

    // The buyer cap is visible on the menu (Distru MCP search-menu-products).
    const planner = { kind: 'agent' as const, id: 'procurement-planner', scopes: ['read' as const] };
    const menus = z.object({ items: z.array(z.object({ id: z.string() })) }).parse(await env.connectors.registry.runReadTool(env.contexts.read, planner, 'distru_mcp.search_menus', {}));
    const onMenu = z
      .object({ items: z.array(z.object({ id: z.string(), maxMenuBuyerOrderQuantity: z.number().nullable() }).passthrough()) })
      .parse(await env.connectors.registry.runReadTool(env.contexts.read, planner, 'distru_mcp.search_menu_products', { menuId: menus.items[0]!.id, productIds: [ids['VAP-BD-1G']!] }));
    expect(onMenu.items[0]!.maxMenuBuyerOrderQuantity).toBe(25);

    // Idempotent: executing again writes nothing anywhere.
    const before = { po: env.net.purchaseWrites, tasks: env.net.taskWrites, mcp: mcpWrites(env), mail: env.outbox.deliveries };
    expect(before).toEqual({ po: 3, tasks: 3, mcp: p.ops.filter((op) => op.action === CAP_ACTION).length, mail: 3 });
    await env.harness.execute({ ctx: env.contexts.execute, proposalId: p.id });
    expect({ po: env.net.purchaseWrites, tasks: env.net.taskWrites, mcp: mcpWrites(env), mail: env.outbox.deliveries }).toEqual(before);
  });

  test('failure mid-way (the MCP server refuses): earlier ops stay done, later ones untouched, proposal failed; resume finishes without duplicates', async () => {
    const env = await restockEnv();
    const { runId, p } = await suspendedProposal(env);
    const capIndex = p.ops.findIndex((op) => op.action === CAP_ACTION);
    expect(capIndex).toBeGreaterThan(0);
    // Every MCP tools/call gets a 429 until reset: the cap op exhausts its retries.
    await env.configureMock({ mcp_rate_limit: { fail_next: 100, retry_after: 0 } });
    const result = await approveAndFinish(env, runId, p);
    expect(result.status).toBe('failed');
    expect(result.message).toContain(`op #${capIndex} (${CAP_ACTION})`);

    const failed = await env.harness.get(p.id);
    expect(failed.status).toBe('failed');
    expect(failed.ops.slice(0, capIndex).every((op) => op.status === 'executed')).toBe(true);
    expect(failed.ops[capIndex]!.status).toBe('failed');
    expect(failed.ops[capIndex]!.result?.error?.code).toBe('retries_exhausted');
    expect(failed.ops.slice(capIndex + 1).every((op) => op.status === 'pending')).toBe(true);
    expect(env.audit.ofType('op.retry').filter((e) => e.data.opIndex === capIndex).length).toBeGreaterThan(0);
    const writesBefore = env.net.purchaseWrites;
    // The vendor email for the capped SKU's PO was held back (it follows the cap).
    expect(env.outbox.deliveries).toBeLessThan(3);

    // The server recovers; resuming re-runs only what is left.
    await env.configureMock({ mcp_rate_limit: { fail_next: 0 } });
    const resumed = await env.harness.execute({ ctx: env.contexts.execute, proposalId: p.id });
    expect(resumed.status).toBe('executed');
    expect(resumed.ops.every((op) => op.status === 'executed')).toBe(true);
    expect(env.net.purchaseWrites).toBe(3);
    expect(env.net.purchaseWrites).toBeGreaterThanOrEqual(writesBefore);
    expect(env.outbox.deliveries).toBe(3);
    expect(env.net.taskWrites).toBe(3);
    expect(mcpWrites(env)).toBeGreaterThanOrEqual(1);
  });

  test('plan guard: a cap that differs from the computed one is denied and revised; an omitted cap is backfilled by the workflow', async () => {
    const wrong = await restockEnv({ planner: { capOverride: 999 } });
    const { p } = await suspendedProposal(wrong);
    const meta = z.object({ revisions: z.number(), critiques: z.array(z.object({ explanation: z.string() })) }).parse(p.meta);
    expect(meta.revisions).toBe(1);
    expect(meta.critiques[0]!.explanation).toContain('cap must be the computed one');
    // Every cap is back to the computed value after the revision.
    const wrongGuard = z.array(z.object({ product_id: z.string(), cap: z.number() })).parse(p.meta.allocationGuard);
    for (const op of p.ops.filter((o) => o.action === CAP_ACTION)) {
      const cap = CapPayload.parse(op.payload);
      expect(cap.maxMenuBuyerOrderQuantity).toBe(wrongGuard.find((g) => g.product_id === cap.id)!.cap);
    }

    const lazy = await restockEnv({ planner: { skipCaps: true } });
    const { p: q } = await suspendedProposal(lazy);
    const crossTool = z.array(z.object({ action: z.string(), source: z.string() })).parse(q.meta.crossTool);
    const backfilled = crossTool.filter((o) => o.action === CAP_ACTION).map((o) => o.source);
    expect(backfilled.length).toBeGreaterThan(0);
    expect(new Set(backfilled)).toEqual(new Set(['guard-backfill']));
    expect(q.rationale).toContain('Added by the workflow');
  });
});

describe('registry boot: distru_mcp degraded mode', () => {
  test('MCP down at boot: starts without distru_mcp, reports it unhealthy; a refresh connects and rebuilds the registry', async () => {
    const env = await restockEnv({ mcpDown: true });
    expect(env.connectors.mcpStatus).toMatchObject({ state: 'unavailable', registered: false });
    expect(env.connectors.registry.connectors().map((c) => c.id)).toEqual(['distru', 'headset', 'email', 'context']);
    expect(env.connectors.mcpClient()).toBeInstanceOf(McpBridgeClient);

    const service = createConnectorsService(() => env.connectors.registry, () => env.contexts.read, () => env.connectors.mcpStatus);
    const down = await service.list();
    expect(down.map((c) => [c.id, c.health.ok])).toEqual([['distru', true], ['headset', true], ['email', true], ['context', false], [DISTRU_MCP_ID, false]]);
    expect(down.find((c) => c.id === DISTRU_MCP_ID)!.health.detail).toContain('unreachable');

    // A run in degraded mode still proposes POs, emails and tasks; no caps, and it says why.
    const { p } = await suspendedProposal(env);
    expect(p.ops.some((op) => op.action === CAP_ACTION)).toBe(false);
    expect(p.ops.filter((op) => op.action === EMAIL_ACTION).length).toBeGreaterThan(0);
    expect(p.rationale).toContain('distru_mcp) unavailable');
    expect(toolDescriptorsFor(env.connectors.registry, 'procurementPlanner').map((d) => d.toolName)).not.toContain('propose_distru_mcp_mutate_product');

    // The server comes back: the periodic refresh connects and rebuilds the registry; the same harness
    // (registry getter) and the agents (tools resolved per call) see the new connector.
    const refreshed = await env.connectMcp();
    expect(refreshed).toMatchObject({ changed: true, status: { state: 'connected', registered: true } });
    expect(env.connectors.registry.connectors().map((c) => c.id)).toContain(DISTRU_MCP_ID);
    expect(env.harness.registry.action(CAP_ACTION).risk).toBe('medium');
    expect(Object.keys(await env.agents.procurementPlanner.listTools())).toContain('propose_distru_mcp_mutate_product');
    const up = await service.list();
    expect(up.find((c) => c.id === DISTRU_MCP_ID)!.health).toMatchObject({ ok: true });
    // A second refresh with an unchanged tool list keeps the registry instance.
    const reg = env.connectors.registry;
    expect((await env.connectors.refresh()).changed).toBe(false);
    expect(env.connectors.registry).toBe(reg);

    // Down again after a successful boot: stays registered (pending proposals may use it), reported unhealthy.
    env.mcpState.down = true;
    await env.connectors.mcpClient().close();
    const again = await env.connectors.refresh();
    expect(again.status).toMatchObject({ state: 'unavailable', registered: true });
    expect(env.connectors.registry.connectors().map((c) => c.id)).toContain(DISTRU_MCP_ID);
  });

  test('disabled (no URL): no distru_mcp entry; buildAppRegistry composes the static connectors', async () => {
    const connectors = new AppConnectors({ connectMcp: null });
    await connectors.start();
    expect(connectors.mcpStatus.state).toBe('disabled');
    expect(buildAppRegistry(null).connectors().map((c) => c.id)).toEqual(['distru', 'headset', 'email', 'context']);
    expect(connectors.registry.actions().map((a) => a.name).sort()).toEqual(['distru.purchases.upsert', 'distru.tasks.create', 'email.send_vendor_po']);
    const env = await restockEnv();
    const service = createConnectorsService(() => connectors.registry, () => env.contexts.read, () => connectors.mcpStatus);
    expect((await service.list()).map((c) => c.id)).toEqual(['distru', 'headset', 'email', 'context']);
  });

  test('error classification is routed by the op connector', () => {
    const http429 = new DistruApiError(429, [{ message: 'slow down', pointer: ['base'] }], 'POST', 'http://x/public/v1/purchases', 3);
    expect(appErrorClassifier.isRetryable(http429, { action: 'distru.purchases.upsert', connectorId: 'distru' })).toBe(true);
    expect(appErrorClassifier.retryAfterMs?.(http429, { action: 'distru.purchases.upsert', connectorId: 'distru' })).toBe(3000);
    // A Distru REST error is not something the email classifier retries.
    expect(appErrorClassifier.isRetryable(http429, { action: 'email.send_vendor_po', connectorId: 'email' })).toBe(false);
    const mcp503 = Object.assign(new Error('Service Unavailable'), { status: 503 });
    expect(appErrorClassifier.isRetryable(mcp503, { action: CAP_ACTION, connectorId: DISTRU_MCP_ID })).toBe(true);
  });
});
