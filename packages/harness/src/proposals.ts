import { opValueOf } from './action';
import type { HarnessDeps } from './context';
import { emit, loadProposal, nowIso } from './context';
import { DecisionConflictError, ForbiddenError, InputValidationError, PolicyDeniedError } from './errors';
import type { PolicyEvaluation, PolicyOutcome } from './policy';
import { assertTransition, SUMMARY_MAX_CHARS, TITLE_MAX_CHARS, totalValue, type Proposal, type ProposalOp, type ProposalStatus } from './proposal';
import { assertBackwardRefs } from './refs';
import { parseWith } from './registry';
import { idempotencyKeyFor } from './runtime';
import { assertScope, sameActor, type Principal } from './scopes';

export interface OpRequest {
  action: string;
  input: unknown;
}

export interface ProposeArgs<TCtx> {
  ctx: TCtx;
  principal: Principal;
  ops: readonly OpRequest[];
  /** Short headline: single line, at most TITLE_MAX_CHARS (InputValidationError otherwise; never truncated). */
  title?: string;
  /** One or two sentences of detail (at most SUMMARY_MAX_CHARS). */
  summary?: string;
  rationale?: string;
  meta?: Record<string, unknown>;
}

/** Title / summary limits (a clear validation error, never a silent truncation). */
export function assertHeadline(title: string | undefined, summary: string | undefined): void {
  if (title !== undefined) {
    if (!title.trim()) throw new InputValidationError('title must not be empty');
    if (/[\r\n]/.test(title)) throw new InputValidationError('title must be a single line');
    if (title.length > TITLE_MAX_CHARS) throw new InputValidationError(`title is ${title.length} characters; at most ${TITLE_MAX_CHARS} (put the detail in summary)`);
  }
  if (summary !== undefined && summary.length > SUMMARY_MAX_CHARS) throw new InputValidationError(`summary is ${summary.length} characters; at most ${SUMMARY_MAX_CHARS}`);
}

export interface OpEdit {
  opIndex: number;
  /** Replacement input; the op is re-planned and re-diffed from it. */
  input: unknown;
}

export interface DecideArgs<TCtx> {
  ctx: TCtx;
  principal: Principal;
  proposalId: string;
  decision: 'approve' | 'reject';
  reason?: string;
  edits?: readonly OpEdit[];
}

const STATUS_FOR: Record<PolicyOutcome, ProposalStatus> = {
  allow: 'auto_approved',
  needs_approval: 'pending_approval',
  deny: 'denied',
};

/** Validate → load before → plan payload → diff → value/vendor facts → idempotency key. */
async function planOp<TCtx>(
  deps: HarnessDeps<TCtx>,
  ctx: TCtx,
  principal: Principal,
  proposalId: string,
  index: number,
  request: OpRequest,
): Promise<ProposalOp> {
  const action = deps.registry.action(request.action);
  assertScope(principal, action.requiredScope);
  const input = parseWith(action.input, request.input, `input for op #${index} (${action.name})`);
  const before = await action.loadBefore(ctx, input);
  const planned = await action.plan(ctx, input, before);
  const payload = action.payload ? parseWith(action.payload, planned, `planned payload for op #${index}`) : planned;
  // `{{op:N.field}}` placeholders may only point at earlier ops (resolved by the executor, in order).
  assertBackwardRefs(payload, index);
  return {
    index,
    action: action.name,
    resource: action.resource,
    risk: action.risk,
    input,
    before,
    payload,
    diff: action.diff(before, payload),
    summary: (await action.summarize?.(input, payload, ctx, before)) ?? null,
    value: opValueOf(action, payload),
    vendorIds: action.vendorIdsOf?.(payload) ?? null,
    idempotencyKey: await idempotencyKeyFor(proposalId, index),
    status: 'pending',
    result: null,
  };
}

async function evaluatePolicy<TCtx>(deps: HarnessDeps<TCtx>, principal: Principal, ops: readonly ProposalOp[]): Promise<PolicyEvaluation> {
  const configs = await deps.policyRules.list();
  return deps.policyEngine.evaluate(
    {
      principal,
      ops: ops.map(({ index, action, resource, risk, payload, value, vendorIds }) => ({ index, action, resource, risk, payload, value, vendorIds })),
      totalValue: totalValue(ops),
    },
    configs,
  );
}

/** Internal knobs for harness-built proposals (undo); not part of the public `ProposeArgs`. */
export interface ProposeOptions {
  /** Use this id (reserved by the caller beforehand). */
  id?: string;
  /** Never auto-approve: an `allow` outcome becomes `needs_approval` (deny still denies). */
  requireApproval?: { rule: string; message: string };
}

export async function propose<TCtx>(deps: HarnessDeps<TCtx>, args: ProposeArgs<TCtx>, options: ProposeOptions = {}): Promise<Proposal> {
  const { ctx, principal } = args;
  assertScope(principal, 'propose');
  if (args.ops.length === 0) throw new InputValidationError('A proposal needs at least one op');
  assertHeadline(args.title, args.summary);

  const id = options.id ?? deps.ids();
  const ops: ProposalOp[] = [];
  for (const [index, request] of args.ops.entries()) {
    ops.push(await planOp(deps, ctx, principal, id, index, request));
  }
  let policy = await evaluatePolicy(deps, principal, ops);
  if (options.requireApproval && policy.outcome !== 'deny') {
    const { rule, message } = options.requireApproval;
    policy = { outcome: 'needs_approval', reasons: [...policy.reasons, { rule, outcome: 'needs_approval', severity: 'info', message }] };
  }
  const now = nowIso(deps);
  const proposal: Proposal = {
    id,
    version: 1,
    status: assertTransition('draft', STATUS_FOR[policy.outcome]),
    title: args.title ?? null,
    summary: args.summary ?? null,
    rationale: args.rationale ?? null,
    meta: args.meta ?? {},
    createdBy: principal,
    createdAt: now,
    updatedAt: now,
    ops,
    policy,
    decision: null,
    execution: null,
  };
  await deps.store.create(proposal);
  await emit(deps, {
    type: 'proposal.created',
    actor: principal,
    proposalId: id,
    data: {
      opCount: ops.length,
      actions: ops.map((op) => op.action),
      totalValue: totalValue(ops),
      // Where the headline came from (an app convention in meta: agent-written and validated, or a code template).
      ...(typeof proposal.meta.titleSource === 'string' ? { titleSource: proposal.meta.titleSource } : {}),
      ...(typeof proposal.meta.titleRejectedReason === 'string' ? { titleRejectedReason: proposal.meta.titleRejectedReason } : {}),
    },
  });
  await emit(deps, { type: 'policy.evaluated', actor: principal, proposalId: id, data: { trigger: 'propose', ...policy } });
  return proposal;
}

/**
 * Record exactly one decision. Concurrent deciders race on the store's compare-and-set; losers get
 * `DecisionConflictError`. Edits (approve only) re-plan the edited ops and re-run policy; a `deny`
 * after edits blocks the approval and leaves the proposal pending.
 */
export async function decide<TCtx>(deps: HarnessDeps<TCtx>, args: DecideArgs<TCtx>): Promise<Proposal> {
  const { ctx, principal, proposalId, decision } = args;
  assertScope(principal, 'approve');
  const current = await loadProposal(deps, proposalId);
  if (current.status !== 'pending_approval') throw new DecisionConflictError(proposalId, current.status);
  if (deps.separationOfDuties && sameActor(current.createdBy, principal)) {
    // Also when the proposer was a token / agent acting for the deciding human (`onBehalfOf`).
    throw new ForbiddenError('Separation of duties: the proposer (or a token acting for them) cannot decide their own proposal');
  }
  const edits = args.edits ?? [];
  if (edits.length && decision !== 'approve') throw new InputValidationError('Edits are only allowed when approving');

  let ops = current.ops;
  let policy = current.policy;
  if (edits.length) {
    ops = [...current.ops];
    for (const edit of edits) {
      const op = ops[edit.opIndex];
      if (!op) throw new InputValidationError(`Edit targets unknown op #${edit.opIndex}`);
      ops[edit.opIndex] = await planOp(deps, ctx, principal, proposalId, edit.opIndex, { action: op.action, input: edit.input });
    }
    policy = await evaluatePolicy(deps, current.createdBy, ops);
    await emit(deps, { type: 'policy.evaluated', actor: principal, proposalId, data: { trigger: 'edit', ...policy } });
    if (policy.outcome === 'deny') {
      await emit(deps, { type: 'proposal.decision_blocked', actor: principal, proposalId, data: { reasons: policy.reasons } });
      throw new PolicyDeniedError('Edited proposal is denied by policy; approval blocked', policy);
    }
  }

  const now = nowIso(deps);
  // Edited approvals keep the ops as originally proposed (`meta.originalOps`), so learners can compare
  // what the agent proposed with what the approver approved (proposal.ops = the edited ops).
  const meta = edits.length && !Array.isArray(current.meta.originalOps) ? { ...current.meta, originalOps: current.ops } : current.meta;
  const next: Proposal = {
    ...current,
    meta,
    ops,
    policy,
    status: assertTransition(current.status, decision === 'approve' ? 'approved' : 'rejected'),
    decision: { decision, by: principal, reason: args.reason ?? null, edited: edits.length > 0, at: now },
    version: current.version + 1,
    updatedAt: now,
  };
  if (!(await deps.store.compareAndSet(next, current.version))) {
    const latest = await deps.store.get(proposalId);
    throw new DecisionConflictError(proposalId, latest?.status ?? 'unknown');
  }
  await emit(deps, {
    type: 'proposal.decided',
    actor: principal,
    proposalId,
    data: { decision, reason: args.reason ?? null, edited: edits.length > 0 },
  });
  return next;
}
