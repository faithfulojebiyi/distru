import { emit, loadProposal, type HarnessDeps } from './context';
import { NotResumableError } from './errors';
import type { Proposal } from './proposal';
import { assertScope, type Principal } from './scopes';

/**
 * A proposal can be resumed when its execution failed (`failed → executing` is a legal transition):
 * the executor skips executed ops and dedupes every write by its idempotency key (or, for an op that was
 * written but failed its read-after-write check, by the record id it recorded), so a resume re-runs only
 * the failed op and what follows. Applies to undo proposals too (a failed undo resumes the same way).
 */
export function isResumable(p: Pick<Proposal, 'status'>): boolean {
  return p.status === 'failed';
}

export interface RequestResumeArgs {
  principal: Principal;
  proposalId: string;
  reason?: string;
}

/**
 * Records that an approver asked to resume a failed proposal (`proposal.resume_requested`). It does
 * not execute: the caller dispatches the same durable executor that runs approved proposals.
 */
export async function requestResume<TCtx>(deps: HarnessDeps<TCtx>, args: RequestResumeArgs): Promise<Proposal> {
  assertScope(args.principal, 'approve');
  const p = await loadProposal(deps, args.proposalId);
  if (!isResumable(p)) throw new NotResumableError(p.id, p.status);
  const failed = p.ops.find((op) => op.status === 'failed');
  await emit(deps, {
    type: 'proposal.resume_requested',
    actor: args.principal,
    proposalId: p.id,
    data: { reason: args.reason ?? null, failedOpIndex: failed?.index ?? null },
  });
  return p;
}
