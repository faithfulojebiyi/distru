import { totalValue, userPrincipal, type Harness, type Proposal } from '@ops/harness';
import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { ApiServices } from '../api/services';
import type { AuditEvent, ProposalDetail, ProposalSummary } from '../api/schemas';
import type { DB } from '../db/client';
import { auditEvent, proposal, proposalOp } from '../db/schema';
import { loadProposal } from '../harness/proposal-store';

type ProposalRow = typeof proposal.$inferSelect;

function toSummary(row: ProposalRow, actions: string[]): ProposalSummary {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    title: row.title,
    createdBy: row.createdBy,
    policyOutcome: row.policyOutcome,
    totalValue: row.totalValue,
    opCount: actions.length,
    actions,
    workflowRunId: row.workflowRunId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Harness Proposal → API detail (summary fields are derived, the rest is the harness shape). */
export function toProposalDetail(p: Proposal): ProposalDetail {
  return {
    id: p.id,
    version: p.version,
    status: p.status,
    title: p.title,
    createdBy: p.createdBy,
    policyOutcome: p.policy.outcome,
    totalValue: totalValue(p.ops),
    opCount: p.ops.length,
    actions: p.ops.map((op) => op.action),
    workflowRunId: typeof p.meta.workflowRunId === 'string' ? p.meta.workflowRunId : null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    rationale: p.rationale,
    meta: p.meta,
    ops: p.ops,
    policy: p.policy,
    decision: p.decision,
    execution: p.execution,
  };
}

/**
 * Reads go straight to Postgres (list needs filtering/paging the harness doesn't offer); the
 * decision goes through `harness.decide`, which enforces the approve scope, separation of duties,
 * exactly-once (compare-and-set on `proposal.version`), edit re-planning and audit.
 */
export function createProposalService<TCtx>(db: DB, harness: Harness<TCtx>, ctxFor: () => TCtx): ApiServices['proposals'] {
  return {
    async list({ status, limit }) {
      const rows = await db
        .select()
        .from(proposal)
        .where(status ? eq(proposal.status, status) : undefined)
        .orderBy(desc(proposal.createdAt))
        .limit(limit);
      if (rows.length === 0) return [];
      const ops = await db
        .select({ proposalId: proposalOp.proposalId, action: proposalOp.action })
        .from(proposalOp)
        .where(
          inArray(
            proposalOp.proposalId,
            rows.map((r) => r.id),
          ),
        )
        .orderBy(asc(proposalOp.opIndex));
      const actions = new Map<string, string[]>();
      for (const op of ops) actions.set(op.proposalId, [...(actions.get(op.proposalId) ?? []), op.action]);
      return rows.map((r) => toSummary(r, actions.get(r.id) ?? []));
    },

    async get(id) {
      const found = await loadProposal(db, id);
      return found ? toProposalDetail(found) : null;
    },

    async decide(id, user, input) {
      const decided = await harness.decide({
        ctx: ctxFor(),
        // Role → scopes (operator: read+propose, approver: +approve). The harness re-checks the scope.
        principal: userPrincipal(user.id, user.role, user.name),
        proposalId: id,
        decision: input.decision,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.edits ? { edits: input.edits } : {}),
      });
      return toProposalDetail(decided);
    },
  };
}

export function createAuditService(db: DB): ApiServices['audit'] {
  return {
    async list({ proposalId, type, order, limit }) {
      const filters: SQL[] = [];
      if (proposalId) filters.push(eq(auditEvent.proposalId, proposalId));
      if (type) filters.push(eq(auditEvent.type, type));
      const rows = await db
        .select()
        .from(auditEvent)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(order === 'asc' ? asc(auditEvent.seq) : desc(auditEvent.seq))
        .limit(limit);
      return rows.map(
        (r): AuditEvent => ({
          id: r.id,
          seq: r.seq,
          type: r.type,
          actor: r.actor,
          proposalId: r.proposalId,
          opIndex: r.opIndex,
          data: r.data,
          at: r.at.toISOString(),
        }),
      );
    },
  };
}
