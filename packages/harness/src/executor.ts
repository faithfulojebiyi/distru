import { anySignal, BudgetExceededError, type Budget } from './budget';
import { emit, loadProposal, nowIso, saveProposal, type HarnessDeps } from './context';
import { CancelledError, InfrastructureError, NotFoundError } from './errors';
import type { AuditEventInput } from './audit';
import { assertTransition, serializeError, type OpResult, type Proposal, type ProposalOp, type SerializedError } from './proposal';
import { resolveOpRefs, type OutputValue } from './refs';
import { parseWith } from './registry';
import { RetriesExhaustedError, withRetry, type RetryOptions } from './retry';
import { EXECUTOR_ACTOR } from './scopes';
import type { Mismatch } from './verify';

export interface ExecuteArgs<TCtx> {
  ctx: TCtx;
  proposalId: string;
  /** Each write/verify attempt charges one step. */
  budget?: Budget;
  signal?: AbortSignal;
}

/** Stable step ids: one durable step per op, plus start/finish bookkeeping steps. */
export const stepIds = {
  start: (proposalId: string) => `proposal:${proposalId}:start`,
  op: (proposalId: string, index: number) => `proposal:${proposalId}:op:${index}`,
  finish: (proposalId: string) => `proposal:${proposalId}:finish`,
};

interface Failure {
  failedOpIndex: number | null;
  error: SerializedError;
}

const isStopError = (err: unknown): err is BudgetExceededError | CancelledError =>
  err instanceof BudgetExceededError || err instanceof CancelledError;

/** Errors that must escape the per-op failure handling. */
const isEscaping = (err: unknown) => isStopError(err) || err instanceof InfrastructureError;

/**
 * Apply an approved proposal, op by op, in order. Safe to call again at any point (after a crash,
 * on a durable-runner replay, or to resume a failed proposal): executed ops are skipped and every
 * write first checks `findByIdempotencyKey`, so nothing is applied twice.
 */
export async function executeProposal<TCtx>(deps: HarnessDeps<TCtx>, args: ExecuteArgs<TCtx>): Promise<Proposal> {
  const { proposalId } = args;
  const signal = args.signal || args.budget ? anySignal(args.signal, args.budget?.signal) : undefined;

  const started = await deps.steps.run(stepIds.start(proposalId), () => start(deps, proposalId));
  if (started.status === 'executed') return started;

  try {
    for (const { index } of started.ops) {
      const op = await deps.steps.run(stepIds.op(proposalId, index), () => runOp(deps, args, index, signal));
      if (op.status === 'failed') {
        const error = op.result?.error ?? { name: 'Error', message: `Op #${index} failed` };
        return await deps.steps.run(stepIds.finish(proposalId), () => finish(deps, proposalId, { failedOpIndex: index, error }));
      }
    }
    return await deps.steps.run(stepIds.finish(proposalId), () => finish(deps, proposalId, null));
  } catch (err) {
    if (!isStopError(err)) throw err; // infrastructure failure: stay `executing` so a retry resumes
    if (err instanceof BudgetExceededError) {
      await emit(deps, {
        type: 'budget.exceeded',
        actor: EXECUTOR_ACTOR,
        proposalId,
        data: { dimension: err.dimension, limit: err.limit, used: err.used },
      });
    }
    return deps.steps.run(stepIds.finish(proposalId), () => finish(deps, proposalId, { failedOpIndex: null, error: serializeError(err) }));
  }
}

async function start<TCtx>(deps: HarnessDeps<TCtx>, proposalId: string): Promise<Proposal> {
  const current = await loadProposal(deps, proposalId);
  if (current.status === 'executed') return current;
  if (current.status === 'executing') {
    await emit(deps, { type: 'proposal.execution_started', actor: EXECUTOR_ACTOR, proposalId, data: { resumed: true } });
    return current;
  }
  const status = assertTransition(current.status, 'executing');
  const next = await saveProposal(deps, current, (p) => ({
    ...p,
    status,
    execution: { startedAt: p.execution?.startedAt ?? nowIso(deps), finishedAt: null, error: null },
  }));
  await emit(deps, {
    type: 'proposal.execution_started',
    actor: EXECUTOR_ACTOR,
    proposalId,
    data: { resumed: current.status === 'failed' },
  });
  return next;
}

async function runOp<TCtx>(deps: HarnessDeps<TCtx>, args: ExecuteArgs<TCtx>, index: number, signal: AbortSignal | undefined): Promise<ProposalOp> {
  const { ctx, proposalId, budget } = args;
  const proposal = await loadProposal(deps, proposalId);
  const op = proposal.ops[index];
  if (!op) throw new NotFoundError(`Proposal ${proposalId} has no op #${index}`);
  if (op.status === 'executed') return op;

  const action = deps.registry.action(op.action);
  const ref = { opIndex: index, action: op.action };
  const connectorId = deps.registry.connectorOf(op.action)?.id;
  let attempts = 0;
  // Audit failures inside the ERP block must not be mistaken for op failures.
  const audit = async (event: AuditEventInput) => {
    try {
      await emit(deps, event);
    } catch (cause) {
      throw new InfrastructureError('Audit sink failed during execution', { cause });
    }
  };
  const retry: RetryOptions = {
    policy: deps.retry,
    classifier: deps.errors,
    context: { action: op.action, ...(connectorId ? { connectorId } : {}) },
    clock: deps.clock,
    random: deps.random,
    signal,
    onRetry: ({ attempt, delayMs, error }) =>
      audit({ type: 'op.retry', actor: EXECUTOR_ACTOR, proposalId, data: { ...ref, attempt, delayMs, error: serializeError(error) } }),
  };
  // ERP interaction only: anything thrown here is an op failure. Persistence happens after, so a
  // store/infra error propagates (op stays pending) and a retry deduplicates via the key.
  let resolved: Record<string, OutputValue> = {};
  const extras = (outputs?: Record<string, OutputValue>) => ({
    ...(outputs ? { outputs } : {}),
    ...(Object.keys(resolved).length ? { resolved } : {}),
  });
  const outcome = await (async (): Promise<{ status: ProposalOp['status']; result: Omit<OpResult, 'finishedAt' | 'attempts'> }> => {
    try {
      const stored = action.payload ? parseWith(action.payload, op.payload, `stored payload for op #${index}`) : op.payload;
      // Op references ({{op:N.field}}) are resolved from earlier ops' results; the stored payload keeps the placeholders.
      const refs = resolveOpRefs(stored, proposal.ops);
      resolved = refs.resolved;
      const payload = Object.keys(resolved).length && action.payload ? parseWith(action.payload, refs.value, `resolved payload for op #${index}`) : refs.value;

      const write = await withRetry(async () => {
        attempts++;
        budget?.charge({ steps: 1 });
        // Dedupe on every attempt: a timed-out write may have landed on the ERP side.
        const existing = await action.findByIdempotencyKey(ctx, op.idempotencyKey);
        if (existing) return { recordId: existing.recordId, record: existing.record, deduplicated: true };
        const written = await action.execute(ctx, payload, op.idempotencyKey);
        return { recordId: written.recordId, record: written.record, deduplicated: false };
      }, retry);
      const { recordId, record, deduplicated } = write.value;
      const outputs = action.outputs?.(record, recordId);
      await audit({
        type: deduplicated ? 'op.deduplicated' : 'op.executed',
        actor: EXECUTOR_ACTOR,
        proposalId,
        data: { ...ref, recordId, idempotencyKey: op.idempotencyKey, attempts, ...(Object.keys(resolved).length ? { resolved } : {}) },
      });

      const verification = await withRetry(() => {
        budget?.charge({ steps: 1 });
        return action.verify(ctx, recordId, payload);
      }, retry);
      if (!verification.value.ok) {
        const mismatches: Mismatch[] = verification.value.mismatches;
        await audit({ type: 'op.verify_failed', actor: EXECUTOR_ACTOR, proposalId, data: { ...ref, recordId, mismatches } });
        const error = { name: 'VerificationFailed', message: `Read-after-write check found ${mismatches.length} mismatch(es)` };
        return { status: 'failed', result: { recordId, deduplicated, mismatches, error, ...extras(outputs) } };
      }
      await audit({ type: 'op.verified', actor: EXECUTOR_ACTOR, proposalId, data: { ...ref, recordId } });
      return { status: 'executed', result: { recordId, deduplicated, mismatches: [], error: null, ...extras(outputs) } };
    } catch (err) {
      if (isEscaping(err)) throw err;
      const exhausted = err instanceof RetriesExhaustedError;
      const error = { ...serializeError(exhausted ? err.cause : err), ...(exhausted ? { code: 'retries_exhausted' } : {}) };
      await audit({ type: 'op.failed', actor: EXECUTOR_ACTOR, proposalId, data: { ...ref, attempts, error } });
      return { status: 'failed', result: { recordId: null, deduplicated: false, mismatches: [], error, ...extras() } };
    }
  })();

  return saveOp(deps, proposalId, index, outcome.status, { ...outcome.result, attempts, finishedAt: nowIso(deps) });
}

async function saveOp<TCtx>(
  deps: HarnessDeps<TCtx>,
  proposalId: string,
  index: number,
  status: ProposalOp['status'],
  result: OpResult,
): Promise<ProposalOp> {
  const current = await loadProposal(deps, proposalId);
  const next = await saveProposal(deps, current, (p) => ({
    ...p,
    ops: p.ops.map((op) => (op.index === index ? { ...op, status, result } : op)),
  }));
  const saved = next.ops[index];
  if (!saved) throw new NotFoundError(`Proposal ${proposalId} has no op #${index}`);
  return saved;
}

async function finish<TCtx>(deps: HarnessDeps<TCtx>, proposalId: string, failure: Failure | null): Promise<Proposal> {
  const current = await loadProposal(deps, proposalId);
  if (current.status !== 'executing') return current; // already finished (replay)
  const status = assertTransition(current.status, failure ? 'failed' : 'executed');
  const next = await saveProposal(deps, current, (p) => ({
    ...p,
    status,
    execution: { startedAt: p.execution?.startedAt ?? null, finishedAt: nowIso(deps), error: failure?.error ?? null },
  }));
  await emit(
    deps,
    failure
      ? { type: 'proposal.failed', actor: EXECUTOR_ACTOR, proposalId, data: failure }
      : { type: 'proposal.executed', actor: EXECUTOR_ACTOR, proposalId, data: { opCount: next.ops.length } },
  );
  return next;
}
