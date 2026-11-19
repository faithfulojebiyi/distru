import { DecisionConflictError, totalValue, UndoOfMetaSchema, userPrincipal, type Harness, type Principal, type Proposal, type Risk, type UndoInfo } from '@ops/harness';
import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { ApiServices } from '../api/services';
import type { AuditEvent, DecisionRequest, ProposalDetail, ProposalSummary } from '../api/schemas';
import type { DB } from '../db/client';
import { auditEvent, proposal, proposalOp } from '../db/schema';
import { loadProposal } from '../harness/proposal-store';

type ProposalRow = typeof proposal.$inferSelect;

/** Where an op writes: its connector (registry) and, for MCP-bridged tools, the systems it reaches. */
export interface OpSystems {
  connector: { id: string; system: string } | null;
  reaches: string[] | null;
}
export type OpSystemsLookup = (action: string) => OpSystems;
const NO_SYSTEMS: OpSystemsLookup = () => ({ connector: null, reaches: null });

/** The op fields a summary row needs (from `proposal_op` or a harness op). */
export interface OpLite {
  index: number;
  action: string;
  summary: string | null;
  risk: Risk;
  status: 'pending' | 'executed' | 'failed';
  value: number | null;
}

const RISK_RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };
export function maxRiskOf(ops: readonly Pick<OpLite, 'risk'>[]): Risk | null {
  let max: Risk | null = null;
  for (const op of ops) if (max === null || RISK_RANK[op.risk] > RISK_RANK[max]) max = op.risk;
  return max;
}

const undoOfMeta = (meta: Record<string, unknown>): string | null => {
  const parsed = UndoOfMetaSchema.safeParse(meta.undoOf);
  return parsed.success ? parsed.data.proposalId : null;
};

function opSummaries(ops: readonly OpLite[], systems: OpSystemsLookup): ProposalSummary['opSummaries'] {
  return [...ops]
    .sort((a, b) => a.index - b.index)
    .map((op) => ({ index: op.index, action: op.action, summary: op.summary, risk: op.risk, status: op.status, value: op.value, ...systems(op.action) }));
}

function toSummary(row: ProposalRow, ops: OpLite[], systems: OpSystemsLookup): ProposalSummary {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    title: row.title,
    createdBy: row.createdBy,
    policyOutcome: row.policyOutcome,
    totalValue: row.totalValue,
    opCount: ops.length,
    actions: [...ops].sort((a, b) => a.index - b.index).map((op) => op.action),
    maxRisk: maxRiskOf(ops),
    opSummaries: opSummaries(ops, systems),
    undoOf: undoOfMeta(row.meta),
    workflowRunId: row.workflowRunId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Harness Proposal → API summary (same derivation as the list rows). */
export function toProposalSummary(p: Proposal, systems: OpSystemsLookup = NO_SYSTEMS): ProposalSummary {
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
    maxRisk: maxRiskOf(p.ops),
    opSummaries: opSummaries(p.ops, systems),
    undoOf: undoOfMeta(p.meta),
    workflowRunId: typeof p.meta.workflowRunId === 'string' ? p.meta.workflowRunId : null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** Harness Proposal (+ its undo availability) → API detail. */
export function toProposalDetail(p: Proposal, undo: UndoInfo, systems: OpSystemsLookup = NO_SYSTEMS): ProposalDetail {
  return {
    ...toProposalSummary(p, systems),
    rationale: p.rationale,
    meta: p.meta,
    ops: p.ops,
    policy: p.policy,
    decision: p.decision,
    execution: p.execution,
    undo,
  };
}

/**
 * Reads go straight to Postgres (list needs filtering/paging the harness doesn't offer); the
 * decision goes through `harness.decide`, which enforces the approve scope, separation of duties,
 * exactly-once (compare-and-set on `proposal.version`), edit re-planning and audit.
 */
/**
 * Called after a decision is recorded (or found already recorded): resumes the workflow run that
 * created the proposal. Must be idempotent and must not throw for "nothing to resume".
 */
export type DecisionHook = (proposal: Proposal) => Promise<void>;

/**
 * Reads go straight to Postgres (list needs filtering/paging the harness doesn't offer); the
 * decision goes through `harness.decide`, which enforces the approve scope, separation of duties,
 * exactly-once (compare-and-set on `proposal.version`), edit re-planning and audit.
 *
 * After `harness.decide` succeeds, `onDecided` resumes the suspended restock run
 * (`proposal.meta.workflowRunId`). Idempotent end to end: a second click gets 409 from the harness
 * but still nudges the run (in case the first resume was lost), and the resume itself is a no-op
 * unless the run is suspended; the workflow step re-reads the proposal, so the decision recorded by
 * the harness (not the resume payload) is what the run acts on.
 */
export interface ProposalServiceOptions {
  onDecided?: DecisionHook;
  onHookError?: (err: unknown, proposalId: string) => void;
  /** Connector / reaches per op for summaries (default: unknown). */
  systems?: OpSystemsLookup;
}

export type ProposalService = ApiServices['proposals'] & {
  /** Decide as any principal (MCP clients); same harness checks and decision hook as `decide`. */
  decideAs: (id: string, principal: Principal, input: DecisionRequest) => Promise<ProposalDetail>;
  /** Detail of a harness proposal (with undo availability). */
  detailOf: (p: Proposal) => Promise<ProposalDetail>;
};

export function createProposalService<TCtx>(db: DB, harness: Harness<TCtx>, ctxFor: () => TCtx, options: ProposalServiceOptions = {}): ProposalService {
  const systems = options.systems ?? NO_SYSTEMS;
  const detailOf = async (p: Proposal) => toProposalDetail(p, await harness.undoInfo(p), systems);
  const nudge = async (p: Proposal) => {
    if (!options.onDecided) return;
    try {
      await options.onDecided(p);
    } catch (err) {
      // The decision is recorded; a failed resume is retried by the next decision call or an operator.
      options.onHookError?.(err, p.id);
    }
  };

  return {
    async list({ status, limit, offset }) {
      const rows = await db
        .select()
        .from(proposal)
        .where(status ? eq(proposal.status, status) : undefined)
        .orderBy(desc(proposal.createdAt), desc(proposal.id))
        .limit(limit)
        .offset(offset ?? 0);
      if (rows.length === 0) return [];
      const ops = await db
        .select({
          proposalId: proposalOp.proposalId,
          index: proposalOp.opIndex,
          action: proposalOp.action,
          summary: proposalOp.summary,
          risk: proposalOp.risk,
          status: proposalOp.status,
          value: proposalOp.value,
        })
        .from(proposalOp)
        .where(
          inArray(
            proposalOp.proposalId,
            rows.map((r) => r.id),
          ),
        )
        .orderBy(asc(proposalOp.opIndex));
      const byProposal = new Map<string, OpLite[]>();
      for (const { proposalId, ...op } of ops) byProposal.set(proposalId, [...(byProposal.get(proposalId) ?? []), op]);
      return rows.map((r) => toSummary(r, byProposal.get(r.id) ?? [], systems));
    },

    async get(id) {
      const found = await loadProposal(db, id);
      return found ? detailOf(found) : null;
    },

    detailOf,

    // Role → scopes (operator: read+propose, approver: +approve). The harness re-checks the scope.
    decide: (id, user, input) => decideAs(id, userPrincipal(user.id, user.role, user.name), input),
    decideAs: (id, principal, input) => decideAs(id, principal, input),
  };

  async function decideAs(id: string, principal: Principal, input: DecisionRequest): Promise<ProposalDetail> {
    let decided: Proposal;
    try {
      decided = await harness.decide({
        ctx: ctxFor(),
        principal,
        proposalId: id,
        decision: input.decision,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.edits ? { edits: input.edits } : {}),
      });
    } catch (err) {
      if (err instanceof DecisionConflictError) {
        const current = await loadProposal(db, id);
        if (current?.decision) await nudge(current);
      }
      throw err;
    }
    await nudge(decided);
    return detailOf(decided);
  }
}

export function createAuditService(db: DB): ApiServices['audit'] {
  return {
    async list({ proposalId, type, order, limit, offset }) {
      const filters: SQL[] = [];
      if (proposalId) filters.push(eq(auditEvent.proposalId, proposalId));
      if (type) filters.push(eq(auditEvent.type, type));
      const rows = await db
        .select()
        .from(auditEvent)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(order === 'asc' ? asc(auditEvent.seq) : desc(auditEvent.seq))
        .limit(limit)
        .offset(offset ?? 0);
      // Op events carry the op's diff and idempotency key (joined from the proposal it belongs to).
      const opKeys = rows.filter((r) => r.proposalId && r.opIndex !== null);
      const ops = opKeys.length
        ? await db
            .select({ proposalId: proposalOp.proposalId, opIndex: proposalOp.opIndex, idempotencyKey: proposalOp.idempotencyKey, diff: proposalOp.diff })
            .from(proposalOp)
            .where(inArray(proposalOp.proposalId, [...new Set(opKeys.map((r) => r.proposalId!))]))
        : [];
      const opOf = new Map(ops.map((o) => [`${o.proposalId}#${o.opIndex}`, o]));
      return rows.map((r): AuditEvent => {
        const op = r.proposalId && r.opIndex !== null ? opOf.get(`${r.proposalId}#${r.opIndex}`) : undefined;
        return {
          id: r.id,
          seq: r.seq,
          type: r.type,
          actor: r.actor,
          proposalId: r.proposalId,
          opIndex: r.opIndex,
          data: r.data,
          at: r.at.toISOString(),
          requestId: r.requestId,
          idempotencyKey: op?.idempotencyKey ?? (typeof r.data.idempotencyKey === 'string' ? r.data.idempotencyKey : null),
          diff: op?.diff ?? null,
        };
      });
    },
  };
}
