/**
 * Execution of approved proposals that no workflow run will execute: proposals created by an agent
 * tool outside a run (Copilot), over MCP, by a script, or by `harness.undo`. Restock / vendor-reply
 * proposals carry `meta.workflowRunId` and their run executes them after the decision; they are only
 * handled here when that run can no longer do it (finished, failed, gone).
 *
 *   decision (UI route, Slack, MCP decide_proposal: all through `proposals.decide*` → `afterDecision`)
 *   or auto-approval of a run-less proposal (agent tool / MCP propose → `afterPropose`)
 *   → Inngest event `ops/proposal.approved` { proposalId } (event id = proposalId: deduped)
 *   → function `proposal-execute` (concurrency 1 per proposal)
 *   → `harness.execute` with the execute ctx (Distru client maxRetries 0, so 429s reach the harness)
 *     and `inngestStepRunner(step)`: one memoized Inngest step per op.
 *
 * Double approvals / retries never double-execute: the event is deduped by id, the function is
 * serialized per proposal, and `harness.execute` skips executed ops and dedupes every write by its
 * idempotency key (an executed proposal returns immediately).
 */
import type { InngestFunction } from 'inngest';
import { z } from 'zod';
import { isExecutable, type Harness, type Proposal, type StepRunner } from '@ops/harness';
import { inngestStepRunner } from '../harness/harness';
import { inngest } from './inngest';
import { isDecisionWorkflowId, RESTOCK_WORKFLOW_ID, type DecisionWorkflowId, type RestockLauncher } from './restock-launcher';

export const PROPOSAL_APPROVED_EVENT = 'ops/proposal.approved';
export const ProposalApprovedEventSchema = z
  .object({
    proposalId: z.string().min(1),
    /** An approver's resume of a FAILED proposal (POST /api/proposals/:id/resume); otherwise only approved ones run. */
    resume: z.boolean().optional(),
  })
  .meta({ id: 'ProposalApprovedEvent' });

const runIdOf = (p: Proposal): string | null => (typeof p.meta.workflowRunId === 'string' && p.meta.workflowRunId ? p.meta.workflowRunId : null);

/** Run statuses after which a run will never execute its proposal. */
const FINISHED_RUN = new Set(['success', 'failed', 'canceled', 'bailed', 'tripwire']);

export interface SendOptions {
  /** Inngest event id (dedupe key, kept 24 h). Default `proposal-approved-<id>`. */
  eventId?: string;
  /** Resume a failed proposal. */
  resume?: boolean;
}

/** Sends `ops/proposal.approved` (event id derived from the proposal id, so repeats are deduped by Inngest). */
export type SendApproved = (proposalId: string, options?: SendOptions) => Promise<void>;

export const approvedEventId = (proposalId: string) => `proposal-approved-${proposalId}`;

export const sendProposalApproved: SendApproved = async (proposalId, options = {}) => {
  await inngest.send({
    id: options.eventId ?? approvedEventId(proposalId),
    name: PROPOSAL_APPROVED_EVENT,
    data: { proposalId, ...(options.resume ? { resume: true } : {}) },
  });
};

/** After propose: a run-less proposal that policy auto-approved is executed right away. */
export function afterPropose(send: SendApproved) {
  return async (p: Proposal): Promise<void> => {
    if (p.status === 'auto_approved' && !runIdOf(p)) await send(p.id);
  };
}

/** What the decision hook needs from the workflow engine (see `launcherRuns`). */
export interface DecisionRuns {
  /** Resume a suspended run with the decision; false when it was not suspended. */
  resume(runId: string, decision: { decision: 'approve' | 'reject'; by: string }, workflowId: DecisionWorkflowId): Promise<boolean>;
  /** The run's status (`running`, `suspended`, `success`, …) or null when it doesn't exist. */
  status(runId: string, workflowId: DecisionWorkflowId): Promise<string | null>;
}

export function launcherRuns(launcher: RestockLauncher): DecisionRuns {
  return {
    resume: (runId, decision, workflowId) => launcher.resumeAfterDecision(runId, decision, workflowId),
    status: async (runId, workflowId) => (await launcher.decisionWorkflow(workflowId).getWorkflowRunById(runId, { fields: [] }))?.status ?? null,
  };
}

export interface AfterDecisionDeps {
  runs: DecisionRuns;
  send: SendApproved;
}

/**
 * The decision hook: resume the run waiting on the proposal (idempotent; no-op unless suspended);
 * for an approval nobody else will execute (no run, or a run that already finished), queue execution.
 * A second click (DecisionConflictError path) passes the current proposal: it is no longer
 * `approved` once execution started, so nothing is queued twice.
 */
export function afterDecision(deps: AfterDecisionDeps) {
  return async (p: Proposal): Promise<void> => {
    if (!p.decision) return;
    const runId = runIdOf(p);
    const workflowId = isDecisionWorkflowId(p.meta.workflowId) ? p.meta.workflowId : RESTOCK_WORKFLOW_ID;
    const resumed = runId ? await deps.runs.resume(runId, { decision: p.decision.decision, by: p.decision.by.id }, workflowId) : false;
    if (p.decision.decision !== 'approve' || p.status !== 'approved' || resumed) return;
    if (runId) {
      const status = await deps.runs.status(runId, workflowId);
      if (status && !FINISHED_RUN.has(status)) return; // still running: it reads the decision itself
    }
    await deps.send(p.id);
  };
}

/**
 * The body of `proposal-execute`, injectable for tests (any StepRunner, any harness). A `failed`
 * proposal only runs when the event is an approver's resume (`resume: true`).
 */
export async function executeApprovedProposal<TCtx>(harness: Harness<TCtx>, ctx: TCtx, proposalId: string, options: { resume?: boolean } = {}): Promise<{ proposalId: string; status: string }> {
  const current = await harness.get(proposalId);
  const runnable = isExecutable(current) || (options.resume === true && current.status === 'failed');
  if (!runnable) {
    return { proposalId, status: current.status }; // executed already, rejected, …: nothing to do
  }
  const done = await harness.execute({ ctx, proposalId });
  return { proposalId, status: done.status };
}

export interface ProposalExecutionDeps<TCtx> {
  /** A harness whose step runner is the given Inngest step tools. */
  harnessFor: (steps: StepRunner) => Harness<TCtx>;
  /** Execute context (Distru client with maxRetries 0). */
  ctx: () => TCtx;
  /** The execution sweeper (registered as an Inngest cron when given). */
  sweep?: () => Promise<SweepResult>;
  /** Default every minute. */
  sweepCron?: string;
}

export function createProposalExecutionFunctions<TCtx>(deps: ProposalExecutionDeps<TCtx>): InngestFunction.Like[] {
  const execute = inngest.createFunction(
    {
      id: 'proposal-execute',
      name: 'Execute approved proposal',
      triggers: [{ event: PROPOSAL_APPROVED_EVENT }],
      concurrency: { key: 'event.data.proposalId', limit: 1 },
    },
    async ({ event, step }) => {
      const { proposalId, resume } = ProposalApprovedEventSchema.parse(event.data);
      return executeApprovedProposal(deps.harnessFor(inngestStepRunner(step)), deps.ctx(), proposalId, resume ? { resume } : {});
    },
  );
  if (!deps.sweep) return [execute];
  const sweep = deps.sweep;
  // Every minute: enqueue approved/auto-approved proposals whose execution was never queued (Inngest
  // unreachable at decision time) or never started. Also run once at boot (src/index.ts).
  const sweeper = inngest.createFunction(
    { id: 'proposal-execution-sweeper', name: 'Execution sweeper', triggers: [{ cron: deps.sweepCron ?? '* * * * *' }], concurrency: { limit: 1 } },
    async ({ step }) => step.run('sweep', () => sweep()),
  );
  return [execute, sweeper];
}

// ── pending-execution markers + sweeper ─────────────────────────────────────────────────────────

export type PendingReason = 'decision' | 'auto_approval' | 'resume' | 'sweeper';

export interface PendingExecution {
  proposalId: string;
  reason: PendingReason;
  lastError: string | null;
  attempts: number;
  createdAt: string;
  lastAttemptAt: string | null;
}

/**
 * Markers for proposals whose execution could not be queued (Postgres `pending_execution`). `mark`
 * upserts (keeps the first reason, counts attempts); `clear` once the event was accepted.
 */
export interface PendingExecutionStore {
  mark(proposalId: string, reason: PendingReason, error: string | null): Promise<void>;
  clear(proposalId: string): Promise<void>;
  list(): Promise<PendingExecution[]>;
}

export class InMemoryPendingExecutionStore implements PendingExecutionStore {
  readonly rows = new Map<string, PendingExecution>();
  constructor(private readonly now: () => Date = () => new Date()) {}
  async mark(proposalId: string, reason: PendingReason, error: string | null): Promise<void> {
    const prev = this.rows.get(proposalId);
    const at = this.now().toISOString();
    this.rows.set(proposalId, { proposalId, reason: prev?.reason ?? reason, lastError: error, attempts: (prev?.attempts ?? 0) + 1, createdAt: prev?.createdAt ?? at, lastAttemptAt: at });
  }
  async clear(proposalId: string): Promise<void> {
    this.rows.delete(proposalId);
  }
  async list(): Promise<PendingExecution[]> {
    return [...this.rows.values()];
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * A `send` that records a pending-execution marker when the queue is unreachable, then rethrows (the
 * caller decides how to report it). The sweeper picks the marker up.
 */
export function sendWithMarker(send: SendApproved, store: PendingExecutionStore, reason: PendingReason): SendApproved {
  return async (proposalId, options) => {
    try {
      await send(proposalId, options);
    } catch (err) {
      await store.mark(proposalId, options?.resume ? 'resume' : reason, message(err));
      throw err;
    }
  };
}

/**
 * The decision hook with a safety net: if resuming the run or queueing execution fails (Inngest down),
 * a marker is recorded so the decision's follow-up is not lost; the error still propagates (logged by
 * the proposal service).
 */
export function guardedAfterDecision(hook: (p: Proposal) => Promise<void>, store: PendingExecutionStore) {
  return async (p: Proposal): Promise<void> => {
    try {
      await hook(p);
    } catch (err) {
      if (p.decision) await store.mark(p.id, 'decision', message(err));
      throw err;
    }
  };
}

export interface SweepDeps {
  store: PendingExecutionStore;
  /** approved / auto_approved proposals last updated before `olderThan` (no execution started). */
  stalled: (olderThan: Date) => Promise<Proposal[]>;
  get: (proposalId: string) => Promise<Proposal | null>;
  runs: DecisionRuns;
  send: SendApproved;
  now?: () => Date;
  /** How long a fresh approval is left to the normal path (decision hook / its run). Default 2 min. */
  graceMs?: number;
  /** Re-send interval for a stalled proposal whose earlier event was accepted but never ran. Default 10 min. */
  resendEveryMs?: number;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface SweepResult {
  checked: number;
  enqueued: string[];
  resumed: string[];
  cleared: string[];
  skipped: string[];
  failed: Array<{ proposalId: string; error: string }>;
}

/**
 * Enqueue approved / auto-approved proposals whose execution never started, idempotently:
 *
 * - **markers** (the queue was down when the decision / auto-approval / resume happened) are retried
 *   right away with the original event id (never accepted, so not deduped) and cleared on success;
 * - **stalled** proposals (approved for longer than the grace period, no marker) are re-sent with a
 *   time-bucketed event id, at most once per `resendEveryMs`, in case an accepted event never ran.
 *
 * Proposals that belong to a workflow run go through the same decision logic as `afterDecision`: a
 * suspended run is resumed, a running one is left alone (it executes itself), a finished or missing
 * run hands the proposal to `proposal-execute`. Double sends are harmless: `proposal-execute` is
 * serialized per proposal and the harness skips executed ops and dedupes every write.
 */
export async function sweepPendingExecutions(deps: SweepDeps): Promise<SweepResult> {
  const now = deps.now?.() ?? new Date();
  const graceMs = deps.graceMs ?? 2 * 60_000;
  const resendEveryMs = deps.resendEveryMs ?? 10 * 60_000;
  const result: SweepResult = { checked: 0, enqueued: [], resumed: [], cleared: [], skipped: [], failed: [] };
  const markers = new Map((await deps.store.list()).map((m) => [m.proposalId, m]));
  const candidates = new Map<string, Proposal>();
  for (const p of await deps.stalled(new Date(now.getTime() - graceMs))) candidates.set(p.id, p);
  for (const id of markers.keys()) {
    if (candidates.has(id)) continue;
    const p = await deps.get(id);
    if (p) candidates.set(id, p);
    else await deps.store.clear(id);
  }
  const bucket = Math.floor(now.getTime() / resendEveryMs);

  for (const p of candidates.values()) {
    result.checked++;
    const marker = markers.get(p.id);
    const eventId = marker ? approvedEventId(p.id) : `proposal-sweep-${p.id}-${bucket}`;
    try {
      const outcome = await ensureExecution(p, marker ?? null, eventId, deps);
      if (outcome === 'enqueued') result.enqueued.push(p.id);
      else if (outcome === 'resumed') result.resumed.push(p.id);
      else result.skipped.push(p.id);
      if (marker && outcome !== 'waiting') {
        await deps.store.clear(p.id);
        result.cleared.push(p.id);
      }
    } catch (err) {
      result.failed.push({ proposalId: p.id, error: message(err) });
      await deps.store.mark(p.id, marker?.reason ?? 'sweeper', message(err)).catch(() => {});
    }
  }
  if (result.enqueued.length || result.resumed.length || result.failed.length) deps.log?.('execution sweep', { ...result });
  return result;
}

type EnsureOutcome = 'enqueued' | 'resumed' | 'waiting' | 'done';

async function ensureExecution(p: Proposal, marker: PendingExecution | null, eventId: string, deps: SweepDeps): Promise<EnsureOutcome> {
  const runId = runIdOf(p);
  const workflowId = isDecisionWorkflowId(p.meta.workflowId) ? p.meta.workflowId : RESTOCK_WORKFLOW_ID;
  switch (p.status) {
    case 'failed':
      if (marker?.reason !== 'resume') return 'done';
      await deps.send(p.id, { eventId: `proposal-resume-${p.id}-v${p.version}`, resume: true });
      return 'enqueued';
    case 'approved':
    case 'rejected': {
      if (!p.decision) return 'done';
      if (runId) {
        const status = await deps.runs.status(runId, workflowId);
        if (status === 'suspended') {
          await deps.runs.resume(runId, { decision: p.decision.decision, by: p.decision.by.id }, workflowId);
          return 'resumed';
        }
        if (status && !FINISHED_RUN.has(status)) return 'waiting'; // still running: it reads the decision itself
      }
      if (p.status !== 'approved') return 'done';
      await deps.send(p.id, { eventId });
      return 'enqueued';
    }
    case 'auto_approved': {
      if (runId) {
        const status = await deps.runs.status(runId, workflowId);
        if (status && !FINISHED_RUN.has(status)) return 'waiting';
      }
      await deps.send(p.id, { eventId });
      return 'enqueued';
    }
    default:
      return 'done'; // executing / executed / pending / denied: nothing to enqueue
  }
}
