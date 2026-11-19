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
import type { Harness, Proposal, StepRunner } from '@ops/harness';
import { inngestStepRunner } from '../harness/harness';
import { inngest } from './inngest';
import { isDecisionWorkflowId, RESTOCK_WORKFLOW_ID, type RestockLauncher } from './restock-launcher';

export const PROPOSAL_APPROVED_EVENT = 'ops/proposal.approved';
export const ProposalApprovedEventSchema = z.object({ proposalId: z.string().min(1) }).meta({ id: 'ProposalApprovedEvent' });

const runIdOf = (p: Proposal): string | null => (typeof p.meta.workflowRunId === 'string' && p.meta.workflowRunId ? p.meta.workflowRunId : null);

/** Run statuses after which a run will never execute its proposal. */
const FINISHED_RUN = new Set(['success', 'failed', 'canceled', 'bailed', 'tripwire']);

/** Sends `ops/proposal.approved` (event id = proposal id, so repeats are deduped by Inngest). */
export type SendApproved = (proposalId: string) => Promise<void>;

export const sendProposalApproved: SendApproved = async (proposalId) => {
  await inngest.send({ id: `proposal-approved-${proposalId}`, name: PROPOSAL_APPROVED_EVENT, data: { proposalId } });
};

/** After propose: a run-less proposal that policy auto-approved is executed right away. */
export function afterPropose(send: SendApproved) {
  return async (p: Proposal): Promise<void> => {
    if (p.status === 'auto_approved' && !runIdOf(p)) await send(p.id);
  };
}

export interface AfterDecisionDeps {
  launcher: Pick<RestockLauncher, 'resumeAfterDecision' | 'decisionWorkflow'>;
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
    const resumed = runId ? await deps.launcher.resumeAfterDecision(runId, { decision: p.decision.decision, by: p.decision.by.id }, workflowId) : false;
    if (p.decision.decision !== 'approve' || p.status !== 'approved' || resumed) return;
    if (runId) {
      const state = await deps.launcher.decisionWorkflow(workflowId).getWorkflowRunById(runId, { fields: [] });
      if (state && !FINISHED_RUN.has(state.status)) return; // still running: it reads the decision itself
    }
    await deps.send(p.id);
  };
}

/** The body of `proposal-execute`, injectable for tests (any StepRunner, any harness). */
export async function executeApprovedProposal<TCtx>(harness: Harness<TCtx>, ctx: TCtx, proposalId: string): Promise<{ proposalId: string; status: string }> {
  const current = await harness.get(proposalId);
  if (current.status !== 'approved' && current.status !== 'auto_approved' && current.status !== 'executing') {
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
      const { proposalId } = ProposalApprovedEventSchema.parse(event.data);
      return executeApprovedProposal(deps.harnessFor(inngestStepRunner(step)), deps.ctx(), proposalId);
    },
  );
  return [execute];
}
