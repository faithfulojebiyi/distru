import { and, count, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { ApiServices } from '../api/services';
import type { Approval, AuditEvent, ProposalSummary } from '../api/schemas';
import type { DB } from '../db/client';
import { approval, auditEvent, proposal, proposalOp } from '../db/schema';

type ProposalRow = typeof proposal.$inferSelect;
type ApprovalRow = typeof approval.$inferSelect;

const iso = (d: Date) => d.toISOString();

function toSummary(row: ProposalRow, opCount: number): ProposalSummary {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    status: row.status,
    workflowRunId: row.workflowRunId,
    createdByType: row.createdByType,
    createdByUserId: row.createdByUserId,
    opCount,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toApproval(row: ApprovalRow): Approval {
  return { ...row, decidedAt: iso(row.decidedAt) };
}

async function opCounts(db: Pick<DB, 'select'>, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ proposalId: proposalOp.proposalId, n: count() })
    .from(proposalOp)
    .where(inArray(proposalOp.proposalId, ids))
    .groupBy(proposalOp.proposalId);
  return new Map(rows.map((r) => [r.proposalId, r.n]));
}

export function createProposalService(db: DB): ApiServices['proposals'] {
  return {
    async list({ status, limit }) {
      const rows = await db
        .select()
        .from(proposal)
        .where(status ? eq(proposal.status, status) : undefined)
        .orderBy(desc(proposal.createdAt))
        .limit(limit);
      const counts = await opCounts(
        db,
        rows.map((r) => r.id),
      );
      return rows.map((r) => toSummary(r, counts.get(r.id) ?? 0));
    },

    async get(id) {
      const [row] = await db.select().from(proposal).where(eq(proposal.id, id));
      if (!row) return null;
      const ops = await db
        .select()
        .from(proposalOp)
        .where(eq(proposalOp.proposalId, id))
        .orderBy(proposalOp.seq);
      const [decision] = await db.select().from(approval).where(eq(approval.proposalId, id));
      return {
        ...toSummary(row, ops.length),
        reasoning: row.reasoning,
        policyChecks: row.policyChecks,
        ops: ops.map((o) => ({
          id: o.id,
          seq: o.seq,
          resource: o.resource,
          op: o.op,
          payload: o.payload,
          before: o.before ?? null,
          diff: o.diff,
          idempotencyKey: o.idempotencyKey,
          status: o.status,
          result: o.result,
          distruRecordId: o.distruRecordId,
        })),
        approval: decision ? toApproval(decision) : null,
      };
    },

    /**
     * Single decision under a row lock: lock the proposal, require `pending_approval`, insert the
     * approval (unique per proposal as a second guard), flip status and append an audit event.
     * Resuming the suspended workflow run is wired on day 3.
     */
    async decide(id, user, input) {
      return db.transaction(async (tx) => {
        const [row] = await tx.select().from(proposal).where(eq(proposal.id, id)).for('update');
        if (!row) return { ok: false, reason: 'not_found' } as const;
        if (row.status !== 'pending_approval') return { ok: false, reason: 'already_decided' } as const;

        const [decision] = await tx
          .insert(approval)
          .values({ proposalId: id, decision: input.decision, decidedBy: user.id, reason: input.reason ?? null })
          .returning();
        const [updated] = await tx
          .update(proposal)
          .set({ status: input.decision === 'approved' ? 'approved' : 'rejected' })
          .where(eq(proposal.id, id))
          .returning();
        await tx.insert(auditEvent).values({
          actorType: 'user',
          actorUserId: user.id,
          action: `proposal.${input.decision}`,
          subjectType: 'proposal',
          subjectId: id,
          data: { reason: input.reason ?? null, role: user.role },
        });
        const counts = await opCounts(tx, [id]);
        return {
          ok: true,
          proposal: toSummary(updated!, counts.get(id) ?? 0),
          approval: toApproval(decision!),
        } as const;
      });
    },
  };
}

export function createAuditService(db: DB): ApiServices['audit'] {
  return {
    async list({ subjectType, subjectId, limit }) {
      const filters: SQL[] = [];
      if (subjectType) filters.push(eq(auditEvent.subjectType, subjectType));
      if (subjectId) filters.push(eq(auditEvent.subjectId, subjectId));
      const rows = await db
        .select()
        .from(auditEvent)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(auditEvent.createdAt))
        .limit(limit);
      return rows.map((r): AuditEvent => ({ ...r, createdAt: iso(r.createdAt) }));
    },
  };
}
