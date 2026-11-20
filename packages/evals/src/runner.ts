import { join } from 'node:path';
import { totalValue, type Proposal } from '@ops/harness';
import { z } from 'zod';
import { AGENT_KEYS, AGENTS, agentKeyOf, type AgentKey } from '../../../apps/agent/src/mastra/agents/roster';
import { RestockResultSchema, VetoedLineSchema } from '../../../apps/agent/src/mastra/workflows/restock';
import { resumeRunOnDecision, toRunDetail } from '../../../apps/agent/src/services/runs';
import { evaluateAll, type AssertionResult, type JudgeVerdict } from './assertions';
import { judgeAnswer } from './judge';
import { anthropicModel, BudgetExceeded, LlmGateway, recordingExists, removeRecording, type EvalMode, type LlmSession, type Pricing } from './llm';
import { emptyObservation, ObservationSchema, UsageSchema, type Observation, type ObservedLine } from './observation';
import { AssertionResultSchema } from './assertions';
import type { Scenario } from './scenario';
import { createWorld, DISTRU_WEBHOOK_SECRET, type World } from './world';
import { SLACK_MEMBERS } from './emulators';
import { writeVectorSnapshot } from './recall';
import { buildPurchaseOrder, DistruApiError } from '@ops/distru-client';
import { agentPrincipal, ingestWebhook, triggerSource, userPrincipal } from '@ops/harness';
import { distruOrderCreatedTrigger, DistruOrderCreatedEventSchema, DISTRU_ORDER_TRIGGER_ID } from '../../../apps/agent/src/api/distru-webhook';
import type { AppCtx } from '../../../apps/agent/src/harness/registry';
import { createOpsMcpTools, type OpsMcpDeps } from '../../../apps/agent/src/mastra/mcp/ops-mcp';
import { VendorReplyResultSchema } from '../../../apps/agent/src/mastra/workflows/vendor-reply';
import { createMcpTokenService, InMemoryMcpTokenStore } from '../../../apps/agent/src/services/mcp-tokens';

// ── result schemas ──────────────────────────────────────────────────────────────────────────────

export const ScenarioStatusSchema = z.enum(['pass', 'fail', 'error', 'pending', 'missing_recording', 'skipped']);
export type ScenarioStatus = z.infer<typeof ScenarioStatusSchema>;

export const ScenarioResultSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: ScenarioStatusSchema,
    reason: z.string().nullable(),
    mode: z.enum(['offline', 'record', 'live']),
    model: z.string(),
    assertions: z.array(AssertionResultSchema),
    passed: z.number().int(),
    failed: z.number().int(),
    usage: UsageSchema,
    /** Calls answered by the real provider in this run (record/live). */
    realCalls: z.number().int(),
    latencyMs: z.number(),
    observation: ObservationSchema.nullable(),
    /**
     * Whether a missing recording fails the suite. false only for an `awaiting_recording` scenario that
     * has never been recorded; every other result is blocking.
     */
    blocking: z.boolean().default(true),
  })
  .meta({ id: 'EvalScenarioResult' });
export type ScenarioResult = z.infer<typeof ScenarioResultSchema>;

export interface RunnerOptions {
  mode: EvalMode;
  model: string;
  judgeModel?: string;
  /** Run `llm_judge` assertions (costs judge calls in record/live; replayed offline). */
  judge: boolean;
  pricing: Pricing;
  recordingsDir: string;
  apiKey?: string;
  /** record mode: re-record scenarios that already have a recording. */
  force?: boolean;
  gateway: LlmGateway;
  log?: (line: string) => void;
}

export const recordingPath = (dir: string, id: string) => join(dir, `${id}.json`);

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const LinesInput = z.object({
  vendor_id: z.string(),
  location_id: z.string(),
  lines: z.array(z.object({ product_id: z.string(), quantity: z.number(), unit_price: z.number() })),
});
const Meta = z.object({
  vetoedLines: z.array(VetoedLineSchema).default([]),
  suspiciousText: z.array(z.object({ sku: z.string().nullable(), source: z.string() })).default([]),
  revisions: z.number().default(0),
});

const MergedAtRisk = z.object({
  output: z.array(
    z.object({
      items: z.array(z.object({ sku: z.string(), recommendation: z.string().nullish(), flagged_by: z.string().nullish(), retail_signal: z.string().nullish() })),
    }),
  ),
});

/** Tool names in an agent.generate() result: every `tool-call` chunk (Mastra puts the name in `payload`). */
export function toolNamesIn(value: unknown, out: string[] = [], seen = new Set<string>()): string[] {
  if (Array.isArray(value)) {
    for (const v of value) toolNamesIn(v, out, seen);
    return out;
  }
  if (!isRecord(value)) return out;
  if (value.type === 'tool-call') {
    const payload = isRecord(value.payload) ? value.payload : value;
    const id = typeof payload.toolCallId === 'string' ? payload.toolCallId : null;
    if (typeof payload.toolName === 'string' && (!id || !seen.has(id))) {
      if (id) seen.add(id);
      out.push(payload.toolName);
    }
    return out;
  }
  for (const k of ['steps', 'toolCalls', 'content', 'response', 'messages']) if (k in value) toolNamesIn(value[k], out, seen);
  return out;
}

/** `agent-inventoryAnalyst` (Mastra's subagent tool) → `inventory-analyst`. */
export function agentOfTool(tool: string): string | null {
  const m = /^agent-(.+)$/.exec(tool);
  if (!m?.[1]) return null;
  const key = AGENT_KEYS.find((k) => k === m[1]) ?? agentKeyOf(m[1]);
  return key ? AGENTS[key].id : m[1];
}

function linesOf(p: Proposal, skus: Map<string, string>): ObservedLine[] {
  return p.ops.flatMap((op) => {
    if (op.action !== 'distru.purchases.upsert') return [];
    const parsed = LinesInput.safeParse(op.input);
    if (!parsed.success) return [];
    return parsed.data.lines.map((l) => ({
      productId: l.product_id,
      sku: skus.get(l.product_id) ?? null,
      quantity: l.quantity,
      unitPrice: l.unit_price,
      vendorId: parsed.data.vendor_id,
      locationId: parsed.data.location_id,
    }));
  });
}

function proposalFacts(p: Proposal): NonNullable<Observation['proposal']> {
  return {
    id: p.id,
    status: p.status,
    policyOutcome: p.policy.outcome,
    totalValue: totalValue(p.ops),
    title: p.title ?? null,
    summary: p.summary ?? null,
    titleSource: typeof p.meta.titleSource === 'string' ? p.meta.titleSource : null,
    ops: p.ops.map((op) => ({
      action: op.action,
      status: op.status,
      verified: op.result ? op.status === 'executed' && op.result.error === null && op.result.mismatches.length === 0 : null,
      diff: op.diff.map((d) => ({ field: String(d.path.at(-1) ?? ''), before: d.before, after: d.after })),
      input: JSON.stringify(op.input).slice(0, 4000),
    })),
  };
}

// ── scenario execution ──────────────────────────────────────────────────────────────────────────

async function resolveScope(world: World, scenario: Scenario) {
  const locs = await world.locations();
  const locationIds = scenario.scope.locations.map((prefix) => {
    const hit = locs.find((l) => l.name.startsWith(prefix));
    if (!hit) throw new Error(`scope: no location starting with "${prefix}" (have ${locs.map((l) => l.name).join(', ')})`);
    return hit.id;
  });
  const productIds = scenario.scope.skus ? await Promise.all(scenario.scope.skus.map((s) => world.productId(s))) : undefined;
  return { locationIds, productIds };
}

export async function runRestock(world: World, scenario: Scenario, observation: Observation): Promise<void> {
  if (scenario.trigger.kind !== 'restock') return;
  const trigger = scenario.trigger;
  for (const c of scenario.emulatorSetup.distruMockConfig) if (c.phase === 'before_run') await world.configureMock(c.body);
  const { locationIds, productIds } = await resolveScope(world, scenario);
  const { runId } = await world.launcher.start({
    triggeredBy: `evals:${scenario.id}`,
    ...(trigger.note ? { scenarioNote: trigger.note } : {}),
    ...(locationIds.length ? { locationIds } : {}),
    ...(productIds ? { productIds } : {}),
  });
  let state = await world.waitFor(runId, ['suspended', 'success']);

  if (state.status === 'suspended' && trigger.slackClicks.length) {
    const emu = world.emu;
    if (!emu) throw new Error('slackClicks need the Slack emulator (world.emu)');
    for (const click of trigger.slackClicks) {
      const pending = await world.findProposalByRunId(runId);
      if (!pending) break;
      const outcome = await emu.clickSlack(SLACK_MEMBERS[click.as], pending, click.action === 'approve' ? 'proposal_approve' : 'proposal_reject');
      observation.slackClicks.push({ as: click.as, ...outcome });
    }
    // an accepted decision resumed the run (approve → execute, reject → finish)
    if (observation.slackClicks.some((c) => c.outcome === 'decided')) state = await world.waitFor(runId, ['success']);
  } else if (state.status === 'suspended' && trigger.approve) {
    for (const c of scenario.emulatorSetup.distruMockConfig) if (c.phase === 'before_execute') await world.configureMock(c.body);
    const pending = await world.findProposalByRunId(runId);
    if (pending) {
      const decided = await world.harness.decide({ ctx: world.contexts.read, principal: world.approver, proposalId: pending.id, decision: 'approve', reason: 'eval: approve' });
      await resumeRunOnDecision(world.launcher)(decided);
      state = await world.waitFor(runId, ['success']);
    }
  }

  await observeRestockRun(world, runId, state, observation);
  const proposal = await world.findProposalByRunId(runId);
  if (proposal) {
    if (trigger.reexecute && (proposal.status === 'executed' || proposal.status === 'failed')) {
      const before = world.net.purchaseWrites + world.net.taskWrites;
      await world.harness.execute({ ctx: world.contexts.execute, proposalId: proposal.id });
      observation.reexecuteWrites = world.net.purchaseWrites + world.net.taskWrites - before;
    }
    if (trigger.undo) observation.undo = await undoProposal(world, await world.harness.get(proposal.id), trigger.undo.reason);
    const latest = await world.harness.get(proposal.id);
    observation.proposal = proposalFacts(latest);
    observation.auditTypes = [...world.audit.types(proposal.id)];
  }
  observation.writes = world.writes();
}

type RunState = Awaited<ReturnType<World['waitFor']>>;

/** What a finished (or suspended) restock run produced: status, agents, tools, the proposal's lines. */
async function observeRestockRun(world: World, runId: string, state: RunState, observation: Observation): Promise<void> {
  observation.runState = state.status;
  const result = RestockResultSchema.safeParse(state.result);
  observation.resultStatus = result.success ? result.data.status : null;
  if (state.status === 'failed') observation.error = state.error?.message ?? 'run failed';

  const merged = MergedAtRisk.safeParse(state.steps?.['merge-at-risk']);
  if (merged.success) {
    observation.atRisk = merged.data.output.flatMap((v) => v.items).map((i) => ({ sku: i.sku, recommendation: i.recommendation ?? null, flaggedBy: i.flagged_by ?? null, retailSignal: i.retail_signal ?? null }));
  }
  const detail = toRunDetail(state, null);
  const entries = detail.steps.flatMap((s) => s.agents);
  observation.agents = [...new Set(entries.map((e) => e.agent))];
  observation.toolCalls = entries.flatMap((e) => e.toolCalls.map((t) => t.tool));

  const proposal = await world.findProposalByRunId(runId);
  if (proposal) {
    const skus = await world.skuById();
    const meta = Meta.safeParse(proposal.meta);
    observation.lines = linesOf(proposal, skus);
    if (meta.success) {
      observation.vetoed = meta.data.vetoedLines.map((v) => ({ sku: v.sku ?? skus.get(v.product_id) ?? null, productId: v.product_id, reasons: v.reasons }));
      observation.suspicious = meta.data.suspiciousText;
      observation.revisions = meta.data.revisions;
    }
    observation.proposal = proposalFacts(proposal);
    observation.auditTypes = [...world.audit.types(proposal.id)];
  }
  observation.writes = world.writes();
}

// ── undo ────────────────────────────────────────────────────────────────────────────────────────

const PURCHASE = 'distru.purchases.upsert';
const TASK = 'distru.tasks.create';
const CAP = 'distru_mcp.mutate_product';
const operatorPrincipal = userPrincipal('u-evals-operator', 'operator', 'Eval Operator');
const secondApprover = userPrincipal('u-evals-approver-2', 'approver', 'Eval Approver 2');

const gone = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return false;
  } catch (err) {
    return err instanceof DistruApiError && err.isNotFound;
  }
};

/**
 * An operator asks to undo the executed proposal, tries to approve the undo himself (must be refused),
 * a second approver approves, the executor applies it; then the world is checked.
 */
async function undoProposal(world: World, original: Proposal, reason: string): Promise<NonNullable<Observation['undo']>> {
  const u = await world.harness.undo({ ctx: world.contexts.read, principal: operatorPrincipal, proposalId: original.id, reason });
  const NotUndoable = z.array(z.object({ opIndex: z.number(), reason: z.string() }));
  const notUndoable = (NotUndoable.safeParse(u.meta.notUndoable).data ?? []).map((n) => ({ action: original.ops[n.opIndex]?.action ?? '?', reason: n.reason }));
  const base = {
    proposalId: u.id,
    status: u.status,
    policyRules: u.policy.reasons.map((r) => r.rule),
    ops: u.ops.map((op) => ({ action: op.action, summary: op.summary ?? null })),
    notUndoable,
  };
  let proposerApproveRefused = false;
  try {
    await world.harness.decide({ ctx: world.contexts.read, principal: operatorPrincipal, proposalId: u.id, decision: 'approve' });
  } catch {
    proposerApproveRefused = true;
  }
  if (u.status !== 'pending_approval') return { ...base, proposerApproveRefused, finalStatus: u.status, after: null };
  const emailsBefore = world.outbox.deliveries;
  await world.harness.decide({ ctx: world.contexts.read, principal: secondApprover, proposalId: u.id, decision: 'approve', reason: 'eval: approve undo' });
  const done = await world.harness.execute({ ctx: world.contexts.execute, proposalId: u.id });
  const distru = world.contexts.read.connectors.distru;
  const recordsOf = (action: string) => original.ops.filter((op) => op.action === action && op.status === 'executed' && op.result?.recordId).map((op) => op.result!.recordId!);
  let purchasesStillThere = 0;
  for (const id of recordsOf(PURCHASE)) if (!(await gone(() => distru.getPurchase(id)))) purchasesStillThere++;
  let tasksStillThere = 0;
  for (const id of recordsOf(TASK)) if (!(await gone(() => distru.getTask(id)))) tasksStillThere++;
  let capsNotRestored = 0;
  for (const op of original.ops.filter((o) => o.action === CAP && o.status === 'executed')) {
    const before = op.diff.find((d) => d.path.at(-1) === 'maxMenuBuyerOrderQuantity')?.before ?? null;
    const id = z.object({ id: z.string() }).safeParse(op.input).data?.id;
    if (!id) continue;
    const out = z.object({ product: z.object({ maxMenuBuyerOrderQuantity: z.number().nullable() }).loose() }).parse(await world.connectors.registry.runReadTool(world.contexts.read, world.approver, 'distru_mcp.get_product', { id }));
    if (out.product.maxMenuBuyerOrderQuantity !== before) capsNotRestored++;
  }
  return {
    ...base,
    proposerApproveRefused,
    finalStatus: done.status,
    after: {
      purchasesStillThere,
      tasksStillThere,
      capsNotRestored,
      emailsBefore,
      emailsAfter: world.outbox.deliveries,
      undoOpsExecuted: done.ops.filter((op) => op.status === 'executed').length,
      undoOps: done.ops.length,
    },
  };
}

// ── vendor reply ────────────────────────────────────────────────────────────────────────────────

/** A PENDING PO for the vendor at Oakland (what a restock run left), then apps/emulators' vendor reply. */
export async function runVendorReply(world: World, scenario: Scenario, observation: Observation): Promise<void> {
  if (scenario.trigger.kind !== 'vendor_reply') return;
  const t = scenario.trigger;
  const emu = world.emu;
  if (!emu) throw new Error('vendor_reply needs the emulators (world.emu)');
  const Product = z.object({ id: z.string(), vendor: z.object({ id: z.string() }), unit_cost: z.number() });
  const product = Product.parse(await world.connectors.registry.runReadTool(world.contexts.read, world.approver, 'distru.products_get', { sku: t.po.sku }));
  const oakland = (await world.locations()).find((l) => l.name.startsWith('Oakland'));
  if (!oakland) throw new Error('no Oakland location');
  const created = await world.contexts.read.connectors.distru.upsertPurchase(
    buildPurchaseOrder({ vendorId: product.vendor.id, locationId: oakland.id, lines: [{ productId: product.id, quantity: t.po.quantity, unitPrice: product.unit_cost }], description: 'Restock' }),
  );
  const po = created.data;
  if (!po?.purchase_number) throw new Error('PO not created');
  const writesBefore = { purchases: world.net.purchaseWrites, tasks: world.net.taskWrites };
  const runId = await emu.simulateVendorReply({
    vendor: t.vendor,
    kind: t.reply,
    poNumber: po.purchase_number,
    sku: t.po.sku,
    ordered: t.po.quantity,
    ...(t.shipped !== undefined ? { shipped: t.shipped } : {}),
    ...(t.eta ? { eta: t.eta } : {}),
  });
  const state = await world.waitFor(runId, ['suspended', 'success'], undefined, 'vendor-reply');
  observation.runState = state.status;
  const result = VendorReplyResultSchema.safeParse(state.result);
  observation.resultStatus = result.success ? result.data.status : state.status;
  if (state.status === 'failed') observation.error = state.error?.message ?? 'run failed';
  const detail = toRunDetail(state, null);
  const entries = detail.steps.flatMap((s) => s.agents);
  observation.agents = [...new Set(entries.map((e) => e.agent))];
  observation.toolCalls = entries.flatMap((e) => e.toolCalls.map((tc) => tc.tool));
  const proposal = await world.findProposalByRunId(runId);
  if (proposal) {
    observation.proposal = proposalFacts(proposal);
    observation.auditTypes = [...world.audit.types(proposal.id)];
    observation.lines = linesOf(proposal, await world.skuById());
  }
  const meta = z.object({ injectionDetected: z.boolean().default(false), suspiciousText: z.array(z.string()).default([]) }).safeParse(proposal?.meta ?? {});
  if ((result.success && result.data.suspicious) || (meta.success && meta.data.injectionDetected)) observation.suspicious.push({ sku: t.po.sku, source: 'vendor email' });
  // writes made by the workflow itself (the PO above was the scenario's setup)
  observation.writes = { ...world.writes(), purchases: world.net.purchaseWrites - writesBefore.purchases, tasks: world.net.taskWrites - writesBefore.tasks };
}

// ── Distru webhook redelivery ───────────────────────────────────────────────────────────────────

/**
 * A sales order is placed in Distru; the mock fires its ORDER CREATE webhook, which Distru delivers
 * `deliveries` times (retries / redeliveries). Each delivery goes through the agent's ingest path
 * (`ingestWebhook` with the Distru trigger, as POST /api/webhooks/distru does), and accepted events
 * are queued by event id the way Inngest dedupes them; each new event starts a restock run.
 */
async function runDistruWebhook(world: World, scenario: Scenario, observation: Observation): Promise<void> {
  if (scenario.trigger.kind !== 'distru_webhook') return;
  const t = scenario.trigger;
  const orders = await placeOrderAndCapture(world, t.location, t.items);
  const runIds: string[] = [];
  observation.webhookDeliveries = await deliverDistruWebhooks(world, orders, t.deliveries, async (order) => {
    const { runId } = await world.launcher.start({
        triggeredBy: `webhook:distru (ORDER ${order.orderId})`,
        productIds: order.productIds,
        ...(order.locationIds.length ? { locationIds: order.locationIds } : {}),
      scenarioNote: `New sales order ${order.orderId}: check whether the ordered products need restocking.`,
    });
    runIds.push(runId);
  });
  observation.runsStarted = runIds.length;
  for (const runId of runIds) await observeRestockRun(world, runId, await world.waitFor(runId, ['suspended', 'success']), observation);
}

/**
 * Delivers each captured webhook `deliveries` times through the agent's ingest path; accepted events
 * are queued by event id (Inngest's dedupe), and `onNewEvent` runs once per distinct event.
 */
export async function deliverDistruWebhooks(
  world: Pick<World, 'audit'>,
  hooks: readonly { raw: string; headers: Headers }[],
  deliveries: number,
  onNewEvent: (order: z.infer<typeof DistruOrderCreatedEventSchema>) => Promise<void>,
): Promise<Observation['webhookDeliveries']> {
  const seen = new Set<string>();
  const out: Observation['webhookDeliveries'] = [];
  for (let i = 0; i < deliveries; i++) {
    for (const hook of hooks) {
      const result = await ingestWebhook(triggerSource([distruOrderCreatedTrigger]), DISTRU_ORDER_TRIGGER_ID, hook.raw, hook.headers, { DISTRU_WEBHOOK_SECRET }, { audit: world.audit });
      out.push({ status: result.status, eventId: result.status === 'accepted' ? result.event.id : null });
      if (result.status !== 'accepted' || seen.has(result.event.id)) continue; // Inngest: one event id, one run
      seen.add(result.event.id);
      await onNewEvent(DistruOrderCreatedEventSchema.parse(result.event.data));
    }
  }
  return out;
}

/** The mock's ORDER webhook deliveries for a simulated sales order at `location` (prefix). */
export async function placeOrderAndCapture(world: World, location: string, items: readonly { sku: string; quantity: number }[]) {
  const captured: { raw: string; headers: Headers }[] = [];
  world.distruHook.handler = async (_url, init) => {
    captured.push({ raw: String(init.body ?? ''), headers: new Headers(init.headers) });
    return new Response('ok');
  };
  const loc = (await world.locations()).find((l) => l.name.startsWith(location));
  if (!loc) throw new Error(`no location starting with ${location}`);
  const res = await world.mock.app.request('http://mock.test/__mock/simulate/order', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ location_id: loc.id, placed_by: 'sales_rep', items: items.map((i) => ({ sku: i.sku, quantity: i.quantity })) }),
  });
  if (!res.ok) throw new Error(`simulate order failed: ${res.status} ${await res.text()}`);
  await world.mock.webhooks.idle();
  const orders = captured.filter((c) => /"type":\s*"ORDER"/.test(c.raw));
  if (!orders.length) throw new Error('the mock sent no ORDER webhook');
  return orders;
}

// ── our MCP server ──────────────────────────────────────────────────────────────────────────────

/**
 * An MCP client with a token of `tokenScopes` calls `tool`: the token service authenticates it, the
 * server's tool list is the token's (createOpsMcpTools for its scopes), and when the tool is absent
 * it is refused like the SDK's "Unknown tool"; the harness re-check (the tool from a propose-capable
 * list called with this token's principal) must refuse too. No model calls.
 */
export async function runMcpCall(world: World, scenario: Scenario, observation: Observation): Promise<void> {
  if (scenario.trigger.kind !== 'mcp_call') return;
  const t = scenario.trigger;
  const tokens = createMcpTokenService({ store: new InMemoryMcpTokenStore(), audit: world.audit });
  const { token } = await tokens.create({ id: 'u-evals-approver', name: 'Eval Approver' }, { name: 'evals token', scopes: t.tokenScopes });
  const client = await tokens.authenticate(token);
  if (!client) throw new Error('token did not authenticate');
  const deps: OpsMcpDeps<AppCtx> = {
    registry: () => world.connectors.registry,
    harness: world.harness,
    ctxFor: () => world.contexts.read,
    proposals: {
      list: async () => [],
      get: async () => null,
      decideAs: async () => {
        throw new Error('not used');
      },
    },
    audit: { sink: world.audit, list: async () => [] },
    runs: { start: async () => ({ runId: 'run-evals-mcp' }), get: async () => null },
  };
  const listed = createOpsMcpTools(deps, world.connectors.registry, client.principal.scopes);
  let args: Record<string, unknown>;
  if (t.args === '$po_input') {
    const Product = z.object({ id: z.string(), vendor: z.object({ id: z.string() }), unit_cost: z.number() });
    const p = Product.parse(await world.connectors.registry.runReadTool(world.contexts.read, world.approver, 'distru.products_get', { sku: 'FLW-BD-35' }));
    const oakland = (await world.locations()).find((l) => l.name.startsWith('Oakland'));
    args = { vendor_id: p.vendor.id, location_id: oakland?.id ?? '', lines: [{ product_id: p.id, quantity: 24, unit_price: p.unit_cost }] };
  } else args = t.args;
  const input = { intent: 'Restock Blue Dream at Oakland (eval)', ...args };
  const authInfo = { mcp: { extra: { authInfo: { extra: { principal: client.principal, tokenId: client.token.id, tokenName: client.token.name } } } } };
  let error: string | null = null;
  let refused = false;
  const tool = listed[t.tool];
  if (!tool) {
    refused = true;
    error = `Unknown tool: ${t.tool} (not in this token's tool list)`;
    // defence in depth: the same tool from a propose-capable server, called with this token's principal
    const full = createOpsMcpTools(deps, world.connectors.registry, ['read', 'propose']);
    const inner = full[t.tool];
    if (inner?.execute) {
      try {
        await inner.execute(input, authInfo as unknown as Parameters<NonNullable<typeof inner.execute>>[1]);
        error += '; but the harness ALLOWED the call';
        refused = false;
      } catch (err) {
        error += `; harness: ${errMsg(err)}`;
      }
    }
  } else if (tool.execute) {
    try {
      await tool.execute(input, authInfo as unknown as Parameters<NonNullable<typeof tool.execute>>[1]);
    } catch (err) {
      refused = true;
      error = errMsg(err);
    }
  }
  observation.mcp = { tools: Object.keys(listed), refused, error, proposalsAfter: (await world.store.list()).length };
  observation.writes = world.writes();
}

// ── direct proposal (no model) ──────────────────────────────────────────────────────────────────

/** Who proposes a `proposal` trigger: the Ops Lead, as it does from the Copilot through its propose_* tools. */
const opsLeadPrincipal = agentPrincipal('ops-lead', 'Ops Lead');

/** The op requests a `proposal` trigger describes, resolved against the seeded mock (ids, vendors, a Metrc package). */
async function proposalOps(world: World, t: Extract<Scenario['trigger'], { kind: 'proposal' }>) {
  const location = (await world.locations()).find((l) => l.name.startsWith(t.location));
  if (!location) throw new Error(`proposal: no location starting with "${t.location}"`);
  const Product = z.object({ id: z.string(), vendor: z.object({ id: z.string() }), unit_cost: z.number() });
  const product = async (sku: string) => Product.parse(await world.connectors.registry.runReadTool(world.contexts.read, world.approver, 'distru.products_get', { sku }));
  const ops: Array<{ action: string; input: Record<string, unknown> }> = [];
  for (const spec of t.ops) {
    if (spec.op === 'purchase') {
      const p = await product(spec.sku);
      ops.push({ action: 'distru.purchases.upsert', input: { vendor_id: p.vendor.id, location_id: location.id, lines: [{ product_id: p.id, quantity: spec.quantity, unit_price: p.unit_cost }] } });
    } else if (spec.op === 'adjust_package') {
      const p = await product(spec.sku);
      // a Metrc-tracked package of the SKU at the location with enough stock for the change
      const lot = [...world.mock.store.lots.values()].find((l) => l.product_id === p.id && l.location_id === location.id && l.compliance_label && l.metrc_id && l.quantity >= Math.abs(spec.quantity));
      if (!lot) throw new Error(`proposal: no Metrc package of ${spec.sku} at ${location.name} with ≥ ${Math.abs(spec.quantity)} units`);
      ops.push({ action: 'distru_mcp.adjust_inventory', input: { packageId: `pkg_${lot.id}`, quantity: spec.quantity, complianceReason: spec.complianceReason, description: spec.description } });
    } else {
      ops.push({ action: 'distru.tasks.create', input: { name: spec.name, due: spec.due, ...(spec.purchaseOp !== undefined ? { purchase_id: `{{op:${spec.purchaseOp}.recordId}}` } : {}) } });
    }
  }
  return ops;
}

/**
 * A cross-tool proposal without a model: the Ops Lead proposes the ops, an approver approves, the
 * executor runs it (faults from `emulatorSetup` before execution); then, while it is failed, an
 * approver resumes it once per `resumes` entry. Each execution is observed separately.
 */
export async function runProposal(world: World, scenario: Scenario, observation: Observation): Promise<void> {
  if (scenario.trigger.kind !== 'proposal') return;
  const t = scenario.trigger;
  for (const c of scenario.emulatorSetup.distruMockConfig) if (c.phase === 'before_run') await world.configureMock(c.body);
  const proposed = await world.harness.propose({ ctx: world.contexts.read, principal: opsLeadPrincipal, ops: await proposalOps(world, t), meta: { triggeredBy: `evals:${scenario.id}` } });
  observation.proposal = proposalFacts(proposed);
  if (proposed.status !== 'pending_approval') {
    observation.auditTypes = [...world.audit.types(proposed.id)];
    observation.writes = world.writes();
    return;
  }
  await world.harness.decide({ ctx: world.contexts.read, principal: world.approver, proposalId: proposed.id, decision: 'approve', reason: 'eval: approve' });
  const step = async (run: () => Promise<unknown>) => {
    const before = world.writes();
    await run();
    const p = await world.harness.get(proposed.id);
    const after = world.writes();
    observation.executions.push({
      proposalStatus: p.status,
      error: p.execution?.error?.message ?? null,
      ops: p.ops.map((op) => ({ action: op.action, status: op.status, recordId: op.result?.recordId ?? null, error: op.result?.error?.message ?? null, mismatches: JSON.stringify(op.result?.mismatches ?? []) })),
      writes: { purchases: after.purchases - before.purchases, tasks: after.tasks - before.tasks, adjustments: after.adjustments - before.adjustments },
    });
  };
  for (const c of scenario.emulatorSetup.distruMockConfig) if (c.phase === 'before_execute') await world.configureMock(c.body);
  await step(() => world.harness.execute({ ctx: world.contexts.execute, proposalId: proposed.id }));
  for (const resume of t.resumes) {
    if (resume.distruMockConfig) await world.configureMock(resume.distruMockConfig);
    await step(async () => {
      await world.harness.requestResume({ principal: world.approver, proposalId: proposed.id, reason: 'eval: resume' });
      await world.harness.execute({ ctx: world.contexts.execute, proposalId: proposed.id });
    });
  }
  const latest = await world.harness.get(proposed.id);
  observation.proposal = proposalFacts(latest);
  observation.auditTypes = [...world.audit.types(proposed.id)];
  observation.writes = world.writes();
}

export async function runCopilot(world: World, scenario: Scenario, observation: Observation): Promise<void> {
  if (scenario.trigger.kind !== 'copilot') return;
  const agent = world.mastra.getAgentById(AGENTS.opsLead.id);
  const result = await agent.generate(scenario.trigger.question, {
    memory: { resource: 'evals', thread: `evals-${scenario.id}` },
    maxSteps: 12,
  });
  observation.answer = result.text;
  observation.toolCalls = toolNamesIn(result);
  const delegated = observation.toolCalls.map(agentOfTool).filter((a): a is string => a !== null);
  observation.agents = [...new Set([AGENTS.opsLead.id, ...delegated])];
  observation.writes = world.writes();
  const proposals = await world.store.list();
  if (proposals[0]) observation.proposal = proposalFacts(proposals[0]);
}

/** Recordings already started over by `--force` in this process. */
const forcedRecordings = new Set<string>();

export async function runScenario(scenario: Scenario, options: RunnerOptions): Promise<ScenarioResult> {
  const log = options.log ?? (() => {});
  const base = {
    id: scenario.id,
    title: scenario.title,
    mode: options.mode,
    model: options.model,
    assertions: [] as AssertionResult[],
    passed: 0,
    failed: 0,
    usage: { llmCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    realCalls: 0,
    latencyMs: 0,
    observation: null,
    blocking: true,
  };
  if (scenario.status === 'pending') return { ...base, status: 'pending', reason: scenario.pendingReason ?? null };

  const recording = recordingPath(options.recordingsDir, scenario.recording ?? scenario.id);
  const mode: EvalMode = options.mode;
  if (scenario.llm && mode === 'offline' && !recordingExists(recording)) {
    const record = `run \`bun run evals:record -- --scenario ${scenario.id}\``;
    if (scenario.status === 'awaiting_recording') return { ...base, status: 'missing_recording', blocking: false, reason: `awaiting its first recording (not a CI failure); ${record}` };
    return { ...base, status: 'missing_recording', reason: `no recording at ${recording}; ${record}` };
  }
  // record: calls already in the recording replay for free; only missing ones reach the model
  // (so a scenario is recorded once, and an interrupted pass resumes). --force starts over.
  // A recording shared by several scenarios is removed once per process, so the others replay it.
  if (mode === 'record' && options.force && !forcedRecordings.has(recording)) {
    forcedRecordings.add(recording);
    if (recordingExists(recording)) removeRecording(recording);
  }
  const file = mode === 'live' ? join(options.recordingsDir, '..', 'reports', 'live', `${scenario.id}.${Date.now()}.json`) : recording;

  let session: LlmSession | null = null;
  let world: World | null = null;
  const observation = emptyObservation(scenario.trigger.kind);
  const started = performance.now();
  let judge: JudgeVerdict | null = null;
  try {
    // A scenario without model calls needs no recording: it never opens an LLM session.
    if (scenario.llm) session = options.gateway.session({ mode, recording: file, model: options.model, pricing: options.pricing, ...(options.apiKey ? { apiKey: options.apiKey } : {}) });
    const model = anthropicModel(options.model);
    const models = Object.fromEntries(AGENT_KEYS.map((k) => [k, model])) as Record<AgentKey, typeof model>;
    const t = scenario.trigger;
    const emulators = t.kind === 'vendor_reply' ? { composio: true } : t.kind === 'restock' && t.slackClicks.length ? { slack: true } : undefined;
    world = await createWorld({
      scenario,
      models,
      pricing: options.pricing,
      ...(emulators ? { emulators } : {}),
      ...(t.kind === 'distru_webhook' ? { distruWebhooks: true } : {}),
      recallVectors: mode === 'offline' ? 'replay' : 'record',
    });
    const emu = world.emu;
    if (session && emu) session.volatile = emu.volatile;
    log(`  ▸ ${scenario.id} (${scenario.llm ? mode : 'no model calls'})`);
    if (t.kind === 'restock') await runRestock(world, scenario, observation);
    else if (t.kind === 'copilot') await runCopilot(world, scenario, observation);
    else if (t.kind === 'vendor_reply') await runVendorReply(world, scenario, observation);
    else if (t.kind === 'distru_webhook') await runDistruWebhook(world, scenario, observation);
    else if (t.kind === 'proposal') await runProposal(world, scenario, observation);
    else await runMcpCall(world, scenario, observation);
    observation.latencyMs = performance.now() - started;

    const judged = scenario.expectations.find((a) => a.kind === 'llm_judge');
    if (judged && judged.kind === 'llm_judge' && options.judge && scenario.trigger.kind === 'copilot') {
      judge = await judgeAnswer(anthropicModel(options.judgeModel ?? options.model), scenario.trigger.question, observation.answer ?? '', judged.criteria);
    }
  } catch (err) {
    if (process.env.EVALS_DEBUG) console.error(err);
    observation.error = err instanceof BudgetExceeded ? err.message : errMsg(err);
    observation.latencyMs = performance.now() - started;
  } finally {
    if (world?.recall) {
      observation.recall = {
        documents: world.recall.documents,
        searches: world.recall.searches.map((r) => ({
          query: r.query,
          passages: r.passages.map((p) => ({ ref: p.ref, date: p.date, subject: p.subject?.untrusted_text ?? null, from: p.from?.untrusted_text ?? null, text: p.text?.untrusted_text ?? null, suspicious: p.suspicious, score: p.score })),
        })),
      };
      // Record mode: keep the vectors computed for this run (new LLM-chosen queries) for offline replay.
      if (mode === 'record' && world.recall.embedder.dirty) writeVectorSnapshot(world.recall.embedder.snapshot());
      if (world.recall.embedder.misses.length && !observation.error) observation.error = `recall: ${world.recall.embedder.misses.length} text(s) without a recorded embedding (stale vector snapshot? re-record)`;
    }
    await world?.close().catch(() => undefined);
    if (session) {
      observation.usage = session.usage();
      const unanswered = session.unanswered();
      if (unanswered > 0 && !observation.error) observation.error = `${unanswered} LLM call(s) had no recording (stale recording? re-record with --force)`;
      options.gateway.detach(session);
    }
  }

  const assertions = evaluateAll(scenario.expectations, observation, judge);
  const failed = assertions.filter((a) => a.status === 'fail').length;
  const passed = assertions.filter((a) => a.status === 'pass').length;
  const stale = session !== null && session.unanswered() > 0;
  const status: ScenarioStatus = stale && mode === 'offline' ? 'missing_recording' : observation.error && failed > 0 ? 'error' : failed > 0 ? 'fail' : 'pass';
  return {
    ...base,
    mode,
    status,
    reason: observation.error,
    assertions,
    passed,
    failed,
    usage: observation.usage,
    realCalls: session?.recordedCalls() ?? 0,
    latencyMs: Math.round(observation.latencyMs),
    observation,
  };
}
