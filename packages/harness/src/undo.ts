/**
 * Undo / rollback.
 *
 * `harness.undo()` never writes. It turns the executed ops of a proposal into a NEW proposal of
 * compensating ops (`<action>.undo`, see compensation.ts), in reverse op order, which then needs
 * policy + a human decision + the executor like any change. The undo proposal links back with
 * `meta.undoOf`; the original records the link in `meta.undo` (so the UI can show "undo pending")
 * and gets a `proposal.undo_proposed` audit event. Ops that cannot be undone are listed with why
 * (an email was delivered, the record was never written, the action has no real undo).
 */
import { z } from 'zod';
import { undoActionName, type AnyAction, type CompensableOp } from './action';
import type { CompensationInput } from './compensation';
import { emit, loadProposal, saveProposal, type HarnessDeps } from './context';
import { HarnessError, InputValidationError } from './errors';
import type { Proposal, ProposalOp } from './proposal';
import { propose, type OpRequest } from './proposals';
import { resolveOpRefs } from './refs';
import { assertScope, type Principal } from './scopes';

/** No undo is possible for this proposal right now (wrong status, outside the window, nothing undoable). */
export class UndoUnavailableError extends HarnessError {
  readonly code = 'undo_unavailable';
  readonly info: UndoInfo;
  constructor(message: string, info: UndoInfo) {
    super(message);
    this.info = info;
  }
}

export const UndoOpInfoSchema = z.object({
  opIndex: z.number().int(),
  action: z.string(),
  summary: z.string().nullable(),
  canUndo: z.boolean(),
  /** Why the op cannot be undone (null when it can). */
  reason: z.string().nullable(),
  /** The undo proposal that covers this op (pending, approved, executing, executed or failed). */
  undoProposalId: z.string().nullable(),
});
export type UndoOpInfo = z.infer<typeof UndoOpInfoSchema>;

export const UndoInfoSchema = z.object({
  /** At least one op can be undone now. */
  available: z.boolean(),
  /** Why nothing can be undone (null when available). */
  reason: z.string().nullable(),
  ops: z.array(UndoOpInfoSchema),
  /** The most recent undo proposal that is still live (not rejected/denied), if any. */
  undoProposalId: z.string().nullable(),
  /** Set when this proposal is itself an undo: the proposal it undoes. */
  undoOf: z.string().nullable(),
  /** Undo is allowed until (ISO), when the harness has an undo window. */
  until: z.string().nullable(),
});
export type UndoInfo = z.infer<typeof UndoInfoSchema>;

/** `proposal.meta.undo` on the original: every undo proposal created for it. */
const UndoLinksSchema = z.object({
  proposals: z.array(z.object({ id: z.string(), opIndexes: z.array(z.number().int()), at: z.string(), by: z.string() })),
});
type UndoLinks = z.infer<typeof UndoLinksSchema>;

/** `proposal.meta.undoOf` on an undo proposal. */
export const UndoOfMetaSchema = z.object({ proposalId: z.string(), opIndexes: z.array(z.number().int()) });

export interface UndoArgs<TCtx> {
  ctx: TCtx;
  /** Needs `propose`; the undo proposal still needs someone with `approve` (separation of duties applies). */
  principal: Principal;
  proposalId: string;
  /** Ops to undo; default: every op that can be undone. */
  opIndexes?: readonly number[];
  reason: string;
}

const UNDOABLE_STATUSES = new Set(['executed', 'failed']);
/** Undo proposals in these states no longer cover their ops (the op can be undone again). */
const DEAD_STATUSES = new Set(['rejected', 'denied']);

function undoLinks(p: Proposal): UndoLinks {
  const parsed = UndoLinksSchema.safeParse(p.meta.undo);
  return parsed.success ? parsed.data : { proposals: [] };
}

/** The executed op as compensation hooks see it: op references (input, payload, diff) resolved from the original proposal. */
export function compensableOp(proposal: Proposal, op: ProposalOp): CompensableOp {
  return {
    index: op.index,
    action: op.action,
    resource: op.resource,
    input: resolveOpRefs(op.input, proposal.ops).value,
    before: op.before,
    payload: resolveOpRefs(op.payload, proposal.ops).value,
    diff: resolveOpRefs(op.diff, proposal.ops).value,
  };
}

function actionOrNull<TCtx>(deps: HarnessDeps<TCtx>, name: string): AnyAction<TCtx> | null {
  try {
    return deps.registry.action(name);
  } catch {
    return null;
  }
}

/** Per-op undo availability for a proposal (pure apart from loading linked undo proposals). */
export async function undoInfo<TCtx>(deps: HarnessDeps<TCtx>, proposalOrId: Proposal | string, undoWindowMs: number | null): Promise<UndoInfo> {
  const proposal = typeof proposalOrId === 'string' ? await loadProposal(deps, proposalOrId) : proposalOrId;
  const undoOf = UndoOfMetaSchema.safeParse(proposal.meta.undoOf);

  // Which ops are covered by a live undo proposal (newest wins).
  const covered = new Map<number, string>();
  let latestLive: string | null = null;
  for (const link of undoLinks(proposal).proposals) {
    const undo = await deps.store.get(link.id);
    if (!undo || DEAD_STATUSES.has(undo.status)) continue;
    latestLive = link.id;
    for (const i of link.opIndexes) covered.set(i, link.id);
  }

  const executedAt = proposal.execution?.finishedAt ?? proposal.execution?.startedAt ?? null;
  const until = undoWindowMs !== null && executedAt ? new Date(Date.parse(executedAt) + undoWindowMs).toISOString() : null;
  const expired = until !== null && deps.clock.now().getTime() > Date.parse(until);

  let proposalReason: string | null = null;
  if (undoOf.success) proposalReason = 'This proposal is itself an undo: propose the original change again instead.';
  else if (!UNDOABLE_STATUSES.has(proposal.status)) proposalReason = `Only executed (or partly executed) proposals can be undone; this one is ${proposal.status}.`;
  else if (expired) proposalReason = `The undo window closed at ${until}.`;

  const ops = proposal.ops.map((op): UndoOpInfo => {
    const base = { opIndex: op.index, action: op.action, summary: op.summary, undoProposalId: covered.get(op.index) ?? null };
    const no = (reason: string): UndoOpInfo => ({ ...base, canUndo: false, reason });
    if (proposalReason) return no(proposalReason);
    if (op.status !== 'executed' || !op.result) return no(op.status === 'failed' ? 'This op failed, so nothing was written.' : 'This op never ran, so nothing was written.');
    const coveredBy = covered.get(op.index);
    if (coveredBy) return no(`Already covered by undo proposal ${coveredBy}.`);
    const action = actionOrNull(deps, op.action);
    if (!action) return no(`Action '${op.action}' is no longer registered (its connector is unavailable).`);
    if (!action.compensate) return no(action.irreversible ?? `'${op.action}' has no compensating action.`);
    let snapshot: CompensableOp;
    try {
      snapshot = compensableOp(proposal, op);
    } catch (err) {
      return no(`Cannot resolve the op's references: ${err instanceof Error ? err.message : String(err)}`);
    }
    const check = action.canCompensate?.(snapshot) ?? { ok: true as const };
    return check.ok ? { ...base, canUndo: true, reason: null } : no(check.reason);
  });

  const available = ops.some((o) => o.canUndo);
  return {
    available,
    reason: available ? null : (proposalReason ?? (ops.length ? 'No op of this proposal can be undone.' : 'The proposal has no ops.')),
    ops,
    undoProposalId: latestLive,
    undoOf: undoOf.success ? undoOf.data.proposalId : null,
    until,
  };
}

/**
 * Create the compensating proposal (see module docs). Throws `UndoUnavailableError` when nothing
 * (or a requested op) cannot be undone, `ForbiddenError` without the `propose` scope.
 */
export async function undo<TCtx>(deps: HarnessDeps<TCtx>, args: UndoArgs<TCtx>, undoWindowMs: number | null): Promise<Proposal> {
  const { ctx, principal, proposalId } = args;
  assertScope(principal, 'propose');
  const reason = args.reason.trim();
  if (!reason) throw new InputValidationError('An undo needs a reason');

  const original = await loadProposal(deps, proposalId);
  const info = await undoInfo(deps, original, undoWindowMs);
  if (!info.available) throw new UndoUnavailableError(info.reason ?? 'Nothing to undo', info);

  const undoable = new Set(info.ops.filter((o) => o.canUndo).map((o) => o.opIndex));
  const requested = args.opIndexes ? [...new Set(args.opIndexes)] : [...undoable];
  const refused = requested.filter((i) => !undoable.has(i));
  if (refused.length) {
    const why = refused.map((i) => `#${i}: ${info.ops.find((o) => o.opIndex === i)?.reason ?? 'no such op'}`).join('; ');
    throw new UndoUnavailableError(`Cannot undo op(s) ${why}`, info);
  }
  if (!requested.length) throw new UndoUnavailableError('No ops selected', info);

  // Reverse op order: later ops may depend on earlier ones (a task linked to a PO, an email about it).
  const opIndexes = [...requested].sort((a, b) => b - a);
  const ops: OpRequest[] = opIndexes.map((i) => {
    const op = original.ops[i]!;
    const snapshot = compensableOp(original, op);
    const input: CompensationInput = { undoOf: { proposalId, opIndex: i }, op: { ...snapshot, result: op.result! } };
    return { action: undoActionName(op.action), input };
  });
  const notUndoable = info.ops
    .filter((o) => !o.canUndo && !requested.includes(o.opIndex))
    .map((o) => ({ opIndex: o.opIndex, reason: o.reason ?? 'cannot be undone' }));
  const skipped = info.ops.filter((o) => o.canUndo && !requested.includes(o.opIndex)).map((o) => ({ opIndex: o.opIndex, reason: 'Not selected' }));

  // Reserve the link on the original first (CAS on its version), so two concurrent undos cannot
  // both cover the same ops; a reservation whose proposal never got created is simply ignored.
  const undoId = deps.ids();
  const links = undoLinks(original);
  const at = deps.clock.now().toISOString();
  await saveProposal(deps, original, (p) => ({
    ...p,
    meta: { ...p.meta, undo: { proposals: [...links.proposals, { id: undoId, opIndexes, at, by: `${principal.kind}:${principal.id}` }] } },
  }));

  const created = await propose(
    deps,
    {
      ctx,
      principal,
      ops,
      title: undoTitle(original.title ?? `proposal ${original.id.slice(0, 8)}`),
      summary: `Undo of "${original.title ?? original.id}"${original.summary ? `: ${original.summary}` : ''}`.slice(0, 1000),
      rationale: reason,
      meta: { undoOf: { proposalId, opIndexes }, undoReason: reason, notUndoable: [...notUndoable, ...skipped] },
    },
    { id: undoId, requireApproval: { rule: 'undo_requires_approval', message: 'Undo proposals always need a human decision' } },
  );
  await emit(deps, {
    type: 'proposal.undo_proposed',
    actor: principal,
    proposalId,
    data: { undoProposalId: created.id, opIndexes, notUndoable: [...notUndoable, ...skipped], reason },
  });
  return created;
}

/** `Undo · <original title>`, kept within 60 characters by shortening the original title (the full one is in summary). */
export function undoTitle(original: string): string {
  const prefix = 'Undo · ';
  const room = 60 - prefix.length;
  return prefix + (original.length <= room ? original : `${original.slice(0, room - 1).trimEnd()}…`);
}
