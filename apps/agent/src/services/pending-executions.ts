import { and, asc, inArray, lt, sql } from 'drizzle-orm';
import type { Proposal } from '@ops/harness';
import type { DB } from '../db/client';
import { pendingExecution, proposal } from '../db/schema';
import { loadProposal } from '../harness/proposal-store';
import type { PendingExecution, PendingExecutionStore, PendingReason } from '../mastra/proposal-executor';

const REASONS: readonly PendingReason[] = ['decision', 'auto_approval', 'resume', 'sweeper'];
const reasonOf = (r: string): PendingReason => REASONS.find((x) => x === r) ?? 'sweeper';

/** `pending_execution` rows (see the table comment in src/db/schema.ts). */
export class DrizzlePendingExecutionStore implements PendingExecutionStore {
  constructor(private readonly db: DB) {}

  async mark(proposalId: string, reason: PendingReason, error: string | null): Promise<void> {
    await this.db
      .insert(pendingExecution)
      .values({ proposalId, reason, lastError: error, attempts: 1, lastAttemptAt: new Date() })
      .onConflictDoUpdate({
        target: pendingExecution.proposalId,
        set: { lastError: error, attempts: sql`${pendingExecution.attempts} + 1`, lastAttemptAt: new Date() },
      });
  }

  async clear(proposalId: string): Promise<void> {
    await this.db.delete(pendingExecution).where(sql`${pendingExecution.proposalId} = ${proposalId}`);
  }

  async list(): Promise<PendingExecution[]> {
    const rows = await this.db.select().from(pendingExecution).orderBy(asc(pendingExecution.createdAt));
    return rows.map((r) => ({
      proposalId: r.proposalId,
      reason: reasonOf(r.reason),
      lastError: r.lastError,
      attempts: r.attempts,
      createdAt: r.createdAt.toISOString(),
      lastAttemptAt: r.lastAttemptAt?.toISOString() ?? null,
    }));
  }
}

/** approved / auto_approved proposals (execution not started) last updated before `olderThan`. */
export async function stalledProposals(db: DB, olderThan: Date, limit = 50): Promise<Proposal[]> {
  const rows = await db
    .select({ id: proposal.id })
    .from(proposal)
    .where(and(inArray(proposal.status, ['approved', 'auto_approved']), lt(proposal.updatedAt, olderThan)))
    .orderBy(asc(proposal.updatedAt))
    .limit(limit);
  const out: Proposal[] = [];
  for (const { id } of rows) {
    const p = await loadProposal(db, id);
    if (p) out.push(p);
  }
  return out;
}
