import type { WorkflowState, WorkflowStateSingleStepResult } from '@mastra/core/workflows';
import { totalValue, type Proposal } from '@ops/harness';
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { ApiServices } from '../api/services';
import type { RunDetail, RunStep, RunSummary } from '../api/schemas';
import type { DB } from '../db/client';
import { proposal } from '../db/schema';
import type { RestockLauncher } from '../mastra/restock-launcher';
import { isDecisionWorkflowId, RESTOCK_WORKFLOW_ID } from '../mastra/restock-launcher';
import { AgentTraceEntrySchema, sumTrace, type AgentTraceEntry } from '../mastra/trace';
import type { DecisionHook } from './proposals';

/** Run ↔ proposal link (by `proposal.workflow_run_id`). */
export type ProposalLink = NonNullable<RunSummary['proposal']>;
export type ProposalLinkLookup = (runIds: string[]) => Promise<Map<string, ProposalLink>>;

export function dbProposalLinks(db: DB): ProposalLinkLookup {
  return async (runIds) => {
    if (!runIds.length) return new Map();
    const rows = await db
      .select({ id: proposal.id, status: proposal.status, title: proposal.title, totalValue: proposal.totalValue, workflowRunId: proposal.workflowRunId })
      .from(proposal)
      .where(inArray(proposal.workflowRunId, runIds));
    return new Map(rows.flatMap((r) => (r.workflowRunId ? [[r.workflowRunId, { id: r.id, status: r.status, title: r.title, totalValue: r.totalValue }] as const] : [])));
  };
}

/** Same lookup over a harness store (tests): proposals are found through `findByRunId`. */
export function harnessProposalLinks(find: (runId: string) => Promise<Proposal | null>): ProposalLinkLookup {
  return async (runIds) => {
    const out = new Map<string, ProposalLink>();
    for (const runId of runIds) {
      const p = await find(runId);
      if (p) out.set(runId, { id: p.id, status: p.status, title: p.title, totalValue: totalValue(p.ops) });
    }
    return out;
  };
}

const iso = (v: number | Date | string | undefined | null): string | null => {
  if (v === undefined || v === null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const RecordSchema = z.record(z.string(), z.unknown());
const asRecord = (v: unknown): Record<string, unknown> | null => {
  const parsed = RecordSchema.safeParse(v);
  return parsed.success ? parsed.data : null;
};

const RUN_STATUSES = ['running', 'suspended', 'success', 'failed', 'canceled', 'pending', 'waiting', 'tripwire', 'bailed', 'paused', 'skipped'] as const;
type RunStatus = (typeof RUN_STATUSES)[number];
const runStatus = (s: string): RunStatus => RUN_STATUSES.find((x) => x === s) ?? 'pending';

/** Every agent trace entry found anywhere in a step output (including foreach arrays), validated. */
function traceEntriesIn(output: unknown): AgentTraceEntry[] {
  const out: AgentTraceEntry[] = [];
  const visit = (v: unknown, depth: number) => {
    if (depth > 3 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    const rec = asRecord(v);
    if (!rec) return;
    const list = z.array(AgentTraceEntrySchema).safeParse(rec.agentTrace);
    if (list.success) out.push(...list.data);
  };
  visit(output, 0);
  return out;
}

const traceKey = (t: AgentTraceEntry) => `${t.agent}|${t.label}|${t.startedAt}`;

function totalsOfEntries(entries: readonly AgentTraceEntry[]): RunSummary['totals'] {
  const spend = sumTrace(entries);
  return { tokens: spend.tokens, costUsd: spend.costUsd, agentCalls: entries.length, toolCalls: entries.reduce((n, t) => n + t.toolCalls.length, 0) };
}

/** Run totals from step outputs (deduplicated agent calls), for list rows. */
export function totalsOf(outputs: readonly unknown[]): RunSummary['totals'] {
  const all = new Map<string, AgentTraceEntry>();
  for (const output of outputs) for (const t of traceEntriesIn(output)) all.set(traceKey(t), t);
  return totalsOfEntries([...all.values()]);
}

function stepResults(raw: WorkflowState['steps'], id: string): WorkflowStateSingleStepResult[] {
  const r = raw?.[id];
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

/** Workflow run state (Mastra storage) → timeline: steps in execution order, each with its agent calls. */
export function toRunDetail(state: WorkflowState, link: ProposalLink | null): RunDetail {
  const steps = state.steps ?? {};
  const all = new Map<string, AgentTraceEntry>();
  for (const id of Object.keys(steps)) {
    for (const r of stepResults(steps, id)) for (const t of traceEntriesIn(r.output)) all.set(traceKey(t), t);
  }
  const entries = [...all.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  const ForeachEntry = z.object({ type: z.literal('foreach'), step: z.object({ step: z.object({ id: z.string() }) }) });
  const foreachIds = new Set((state.serializedStepGraph ?? []).flatMap((e) => {
    const parsed = ForeachEntry.safeParse(e);
    return parsed.success ? [parsed.data.step.step.id] : [];
  }));

  const timeline: RunStep[] = Object.keys(steps).map((stepId) => {
    const results = stepResults(steps, stepId);
    const first = results[0];
    const output = first?.output;
    const startedAt = results.map((r) => r.startedAt).filter((n): n is number => typeof n === 'number');
    const endedAt = results.map((r) => r.endedAt).filter((n): n is number => typeof n === 'number');
    return {
      stepId,
      status: first?.status ?? 'pending',
      startedAt: startedAt.length ? iso(Math.min(...startedAt)) : null,
      endedAt: endedAt.length ? iso(Math.max(...endedAt)) : null,
      suspendedAt: iso(first?.suspendedAt),
      resumedAt: iso(first?.resumedAt),
      iterations: foreachIds.has(stepId) && Array.isArray(output) ? output.length : null,
      agents: entries.filter((t) => t.step === stepId),
      error: first?.error?.message ?? null,
    };
  });
  timeline.sort((a, b) => (a.startedAt ?? '9999').localeCompare(b.startedAt ?? '9999'));

  const totals = totalsOfEntries(entries);
  const suspended = Object.values(steps)
    .flatMap((r) => (Array.isArray(r) ? r : [r]))
    .find((r) => r.status === 'suspended');
  const input = asRecord(state.payload) ?? asRecord(stepResults(steps, 'input')[0]?.output);
  return {
    runId: state.runId,
    workflowId: RESTOCK_WORKFLOW_ID,
    status: runStatus(state.status),
    triggeredBy: typeof input?.triggeredBy === 'string' ? input.triggeredBy : null,
    createdAt: iso(state.createdAt) ?? new Date(0).toISOString(),
    updatedAt: iso(state.updatedAt) ?? new Date(0).toISOString(),
    proposal: link,
    input,
    result: asRecord(state.result),
    error: state.error?.message ?? null,
    steps: timeline,
    totals,
    suspendPayload: asRecord(suspended?.suspendPayload),
  };
}

export interface RunsServiceDeps {
  launcher: RestockLauncher;
  proposalLinks: ProposalLinkLookup;
}

/** Runs come from Mastra's workflow run storage; each is linked to the proposal it created. */
export function createRunsService({ launcher, proposalLinks }: RunsServiceDeps): ApiServices['runs'] {
  return {
    async list({ limit }) {
      const { runs } = await launcher.workflow().listWorkflowRuns({ perPage: limit, page: 0 });
      const links = await proposalLinks(runs.map((r) => r.runId));
      return runs.map((r): RunSummary => {
        const snapshot = typeof r.snapshot === 'string' ? null : r.snapshot;
        const input = asRecord(snapshot?.context.input);
        const totals = totalsOf(Object.values(snapshot?.context ?? {}).map((step) => asRecord(step)?.output));
        return {
          runId: r.runId,
          workflowId: RESTOCK_WORKFLOW_ID,
          status: runStatus(snapshot?.status ?? 'pending'),
          triggeredBy: typeof input?.triggeredBy === 'string' ? input.triggeredBy : null,
          createdAt: iso(r.createdAt) ?? new Date(0).toISOString(),
          updatedAt: iso(r.updatedAt) ?? new Date(0).toISOString(),
          proposal: links.get(r.runId) ?? null,
          totals,
        };
      });
    },

    async get(runId) {
      const state = await launcher.workflow().getWorkflowRunById(runId);
      if (!state || state.isFromInMemory) return null;
      const links = await proposalLinks([runId]);
      return toRunDetail(state, links.get(runId) ?? null);
    },

    async start(input, user) {
      const { runId } = await launcher.start({ triggeredBy: `user:${user.email}`, ...input }, { resourceId: user.id });
      return { runId, workflowId: RESTOCK_WORKFLOW_ID };
    },
  };
}

/**
 * Decision hook: resume the run waiting on this proposal (`meta.workflowRunId`) of the workflow that
 * created it (`meta.workflowId`: `restock` (default) or `vendor-reply`). No-op when the proposal has
 * no run, has no decision yet, or the run is not suspended (already resumed).
 */
export function resumeRunOnDecision(launcher: RestockLauncher): DecisionHook {
  return async (p) => {
    const runId = typeof p.meta.workflowRunId === 'string' ? p.meta.workflowRunId : null;
    if (!runId || !p.decision) return;
    const workflowId = isDecisionWorkflowId(p.meta.workflowId) ? p.meta.workflowId : RESTOCK_WORKFLOW_ID;
    await launcher.resumeAfterDecision(runId, { decision: p.decision.decision, by: p.decision.by.id }, workflowId);
  };
}
