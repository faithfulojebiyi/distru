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
import { createWorld, type World } from './world';

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
    ops: p.ops.map((op) => ({
      action: op.action,
      status: op.status,
      verified: op.result ? op.status === 'executed' && op.result.error === null && op.result.mismatches.length === 0 : null,
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

async function runRestock(world: World, scenario: Scenario, observation: Observation): Promise<void> {
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

  if (state.status === 'suspended' && trigger.approve) {
    for (const c of scenario.emulatorSetup.distruMockConfig) if (c.phase === 'before_execute') await world.configureMock(c.body);
    const pending = await world.findProposalByRunId(runId);
    if (pending) {
      const decided = await world.harness.decide({ ctx: world.contexts.read, principal: world.approver, proposalId: pending.id, decision: 'approve', reason: 'eval: approve' });
      await resumeRunOnDecision(world.launcher)(decided);
      state = await world.waitFor(runId, ['success']);
    }
  }

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
    if (trigger.reexecute && (proposal.status === 'executed' || proposal.status === 'failed')) {
      const before = world.net.purchaseWrites + world.net.taskWrites;
      await world.harness.execute({ ctx: world.contexts.execute, proposalId: proposal.id });
      observation.reexecuteWrites = world.net.purchaseWrites + world.net.taskWrites - before;
    }
    const latest = await world.harness.get(proposal.id);
    observation.proposal = proposalFacts(latest);
    observation.auditTypes = [...world.audit.types(proposal.id)];
  }
  observation.writes = { purchases: world.net.purchaseWrites, tasks: world.net.taskWrites };
}

async function runCopilot(world: World, scenario: Scenario, observation: Observation): Promise<void> {
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
  observation.writes = { purchases: world.net.purchaseWrites, tasks: world.net.taskWrites };
  const proposals = await world.store.list();
  if (proposals[0]) observation.proposal = proposalFacts(proposals[0]);
}

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
  };
  if (scenario.status === 'pending') return { ...base, status: 'pending', reason: scenario.pendingReason ?? null };
  if (scenario.trigger.kind === 'vendor_reply') return { ...base, status: 'pending', reason: 'vendor_reply trigger has no runner yet' };

  const recording = recordingPath(options.recordingsDir, scenario.recording ?? scenario.id);
  const mode: EvalMode = options.mode;
  if (mode === 'offline' && !recordingExists(recording)) {
    return { ...base, status: 'missing_recording', reason: `no recording at ${recording}; run \`bun run evals:record -- --scenario ${scenario.id}\`` };
  }
  // record: calls already in the recording replay for free; only missing ones reach the model
  // (so a scenario is recorded once, and an interrupted pass resumes). --force starts over.
  if (mode === 'record' && options.force && recordingExists(recording)) removeRecording(recording);
  const file = mode === 'live' ? join(options.recordingsDir, '..', 'reports', 'live', `${scenario.id}.${Date.now()}.json`) : recording;

  let session: LlmSession | null = null;
  const observation = emptyObservation(scenario.trigger.kind);
  const started = performance.now();
  let judge: JudgeVerdict | null = null;
  try {
    session = options.gateway.session({ mode, recording: file, model: options.model, pricing: options.pricing, ...(options.apiKey ? { apiKey: options.apiKey } : {}) });
    const model = anthropicModel(options.model);
    const models = Object.fromEntries(AGENT_KEYS.map((k) => [k, model])) as Record<AgentKey, typeof model>;
    const world = await createWorld({ scenario, models, pricing: options.pricing });
    log(`  ▸ ${scenario.id} (${mode})`);
    if (scenario.trigger.kind === 'restock') await runRestock(world, scenario, observation);
    else await runCopilot(world, scenario, observation);
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
