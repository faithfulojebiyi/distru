import { ProposalSchema, totalValue, type Proposal, type ProposalOp, type ProposalStore } from '@ops/harness';
import { and, asc, eq } from 'drizzle-orm';
import type { DB } from '../db/client';
import { approval, proposal, proposalOp } from '../db/schema';

/** A Drizzle handle or a transaction on it (both expose the query builders we use). */
type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
type Executor = DB | Tx;

type ProposalRow = typeof proposal.$inferSelect;
type OpRow = typeof proposalOp.$inferSelect;
type ApprovalRow = typeof approval.$inferSelect;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function proposalValues(p: Proposal): typeof proposal.$inferInsert {
  return {
    id: p.id,
    version: p.version,
    status: p.status,
    title: p.title,
    rationale: p.rationale,
    meta: p.meta,
    createdBy: p.createdBy,
    createdByKind: p.createdBy.kind,
    createdById: p.createdBy.id,
    policy: p.policy,
    policyOutcome: p.policy.outcome,
    totalValue: totalValue(p.ops),
    execution: p.execution,
    workflowId: str(p.meta.workflowId),
    workflowRunId: str(p.meta.workflowRunId),
    createdAt: new Date(p.createdAt),
    updatedAt: new Date(p.updatedAt),
  };
}

function opValues(proposalId: string, op: ProposalOp): typeof proposalOp.$inferInsert {
  return {
    proposalId,
    opIndex: op.index,
    action: op.action,
    resource: op.resource,
    risk: op.risk,
    // `undefined` is not JSON; store it as SQL NULL (read back as null).
    input: op.input ?? null,
    before: op.before ?? null,
    payload: op.payload ?? null,
    diff: op.diff,
    summary: op.summary,
    value: op.value,
    vendorIds: op.vendorIds,
    idempotencyKey: op.idempotencyKey,
    status: op.status,
    result: op.result,
    attempts: op.result?.attempts ?? 0,
    recordId: op.result?.recordId ?? null,
    updatedAt: new Date(),
  };
}

/** Rows → harness Proposal. Parsed with the harness schema so a bad row fails loudly, never silently. */
export function toProposal(row: ProposalRow, ops: OpRow[], decision: ApprovalRow | null): Proposal {
  return ProposalSchema.parse({
    id: row.id,
    version: row.version,
    status: row.status,
    title: row.title,
    rationale: row.rationale,
    meta: row.meta,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ops: [...ops]
      .sort((a, b) => a.opIndex - b.opIndex)
      .map((o) => ({
        index: o.opIndex,
        action: o.action,
        resource: o.resource,
        risk: o.risk,
        input: o.input,
        before: o.before,
        payload: o.payload,
        // JSON has no `undefined`: `before` of an added field / `after` of a removed one come back
        // as missing keys. Restore them so the harness schema (and deep equality) sees the same shape.
        diff: o.diff.map((c) => ({ path: c.path, kind: c.kind, before: c.before, after: c.after })),
        summary: o.summary,
        value: o.value,
        vendorIds: o.vendorIds,
        idempotencyKey: o.idempotencyKey,
        status: o.status,
        result: o.result && {
          ...o.result,
          mismatches: o.result.mismatches.map((m) => ({ path: m.path, expected: m.expected, actual: m.actual })),
        },
      })),
    policy: row.policy,
    decision: decision
      ? { decision: decision.decision, by: decision.decidedBy, reason: decision.reason, edited: decision.edited, at: decision.decidedAt.toISOString() }
      : null,
    execution: row.execution,
  });
}

async function writeOps(tx: Tx, p: Proposal): Promise<void> {
  for (const op of p.ops) {
    const values = opValues(p.id, op);
    const { proposalId: _p, opIndex: _i, ...set } = values;
    await tx
      .insert(proposalOp)
      .values(values)
      .onConflictDoUpdate({ target: [proposalOp.proposalId, proposalOp.opIndex], set });
  }
}

/** The decision record is written once, in the same transaction as the transition that made it. */
async function writeDecision(tx: Tx, p: Proposal): Promise<void> {
  if (!p.decision) return;
  await tx
    .insert(approval)
    .values({
      proposalId: p.id,
      decision: p.decision.decision,
      decidedBy: p.decision.by,
      decidedByKind: p.decision.by.kind,
      decidedById: p.decision.by.id,
      reason: p.decision.reason,
      edited: p.decision.edited,
      decidedAt: new Date(p.decision.at),
    })
    .onConflictDoNothing({ target: approval.proposalId });
}

/** Load one proposal with its ops and decision. Exported for read paths (routes) that bypass the harness. */
export async function loadProposal(db: Executor, id: string): Promise<Proposal | null> {
  const [row] = await db.select().from(proposal).where(eq(proposal.id, id));
  if (!row) return null;
  const ops = await db.select().from(proposalOp).where(eq(proposalOp.proposalId, id)).orderBy(asc(proposalOp.opIndex));
  const [decision] = await db.select().from(approval).where(eq(approval.proposalId, id));
  return toProposal(row, ops, decision ?? null);
}

/**
 * `ProposalStore` over `proposal` + `proposal_op` + `approval`.
 *
 * - `create`: inserts the proposal and its ops in one transaction.
 * - `compareAndSet`: `UPDATE proposal SET … WHERE id = $1 AND version = $2`; zero rows → `false`
 *   (the harness turns that into DecisionConflictError / ConcurrentModificationError). On success
 *   the ops and (first time only) the approval row are written in the same transaction, so a
 *   reader never sees a half-applied transition.
 */
export class DrizzleProposalStore implements ProposalStore {
  constructor(private readonly db: DB) {}

  async create(p: Proposal): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(proposal).values(proposalValues(p));
      await writeOps(tx, p);
      await writeDecision(tx, p);
    });
  }

  get(id: string): Promise<Proposal | null> {
    return loadProposal(this.db, id);
  }

  async compareAndSet(next: Proposal, expectedVersion: number): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const { id: _id, createdAt: _c, ...set } = proposalValues(next);
      const updated = await tx
        .update(proposal)
        .set(set)
        .where(and(eq(proposal.id, next.id), eq(proposal.version, expectedVersion)))
        .returning({ id: proposal.id });
      if (updated.length !== 1) return false;
      await writeOps(tx, next);
      await writeDecision(tx, next);
      return true;
    });
  }
}
