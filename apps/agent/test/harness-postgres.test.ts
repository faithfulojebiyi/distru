/**
 * Integration: the harness against Postgres: the TEST database (`TEST_DATABASE_URL`, default `ops_test`
 * on the docker compose server; created and pushed by test/preload.ts), never the dev database.
 * Skips when the database is unreachable. Creates its own proposals (principal `agent:it-planner`)
 * and deletes them (and their audit events) before and after the run, including leftovers of a
 * crashed run; policy rules are read, never modified.
 */
import { agentPrincipal, type Proposal } from '@ops/harness';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import postgres from 'postgres';
import { createApiRoutes } from '../src/api/routes';
import type { ProposalDetail } from '../src/api/schemas';
import type { ApiServices } from '../src/api/services';
import type { SessionUser } from '../src/auth/session';
import { stubServices } from './fixtures/stub-services';
import { db } from '../src/db/client';
import { approval, auditEvent, proposal } from '../src/db/schema';
import { createAppHarness } from '../src/harness/harness';
import { DrizzleProposalStore } from '../src/harness/proposal-store';
import { createAuditService, createProposalService } from '../src/services/proposals';
import { FAKE_PURCHASE_ACTION, FakeErp, poInput, testRegistry, type TestCtx } from './fixtures/fake-erp';

async function databaseReachable(): Promise<boolean> {
  const probe = postgres(process.env.DATABASE_URL!, { max: 1, connect_timeout: 2, onnotice: () => {} });
  try {
    await probe`select 1 from proposal limit 1`;
    // Schema current (latest additions: audit_event.request_id, mcp_token)?
    await probe`select request_id from audit_event limit 1`;
    await probe`select 1 from mcp_token limit 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 1 }).catch(() => {});
  }
}

const reachable = await databaseReachable();
if (!reachable) console.warn('[harness-postgres] Postgres unreachable or schema not pushed: skipping integration tests');

const users: Record<string, SessionUser> = {
  operator: { id: 'it-operator', email: 'operator@it.test', name: 'IT Operator', role: 'operator' },
  approver: { id: 'it-approver', email: 'approver@it.test', name: 'IT Approver', role: 'approver' },
  approver2: { id: 'it-approver-2', email: 'approver2@it.test', name: 'IT Approver 2', role: 'approver' },
};

const created: string[] = [];

function env() {
  const erp = new FakeErp();
  const ctx: TestCtx = { erp };
  const harness = createAppHarness<TestCtx>({ registry: testRegistry(), db });
  const services: ApiServices = {
    resolveSession: async (h) => users[h.get('authorization')?.replace('Bearer ', '') ?? ''] ?? null,
    checkDatabase: async () => true,
    proposals: createProposalService(db, harness, () => ctx),
    audit: createAuditService(db),
    ...stubServices(),
  };
  const api = createApiRoutes(services);
  const decide = (id: string, as: string, body: unknown = { decision: 'approve', reason: 'restock is due' }) =>
    api.request(`/api/proposals/${id}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${as}` },
      body: JSON.stringify(body),
    });
  const propose = async (): Promise<Proposal> => {
    const p = await harness.propose({
      ctx,
      principal: agentPrincipal(IT_PLANNER, 'Procurement Planner'),
      ops: [{ action: FAKE_PURCHASE_ACTION, input: poInput() }],
      title: 'Restock Blue Dream',
      rationale: 'Below reorder point at 2 locations',
      meta: { workflowRunId: 'run-it-1' },
    });
    created.push(p.id);
    return p;
  };
  return { erp, ctx, harness, api, decide, propose };
}

/** Integration proposals are created by this principal only; anything it left behind is swept. */
const IT_PLANNER = 'it-planner';

/** Deletes every proposal (+ ops, approvals, audit events) created by the test principal, incl. leftovers of crashed runs. */
async function sweep(): Promise<void> {
  const rows = await db.select({ id: proposal.id }).from(proposal).where(eq(proposal.createdById, IT_PLANNER));
  const ids = [...new Set([...rows.map((r) => r.id), ...created])];
  if (!ids.length) return;
  await db.delete(auditEvent).where(inArray(auditEvent.proposalId, ids));
  await db.delete(proposal).where(inArray(proposal.id, ids)); // cascades proposal_op + approval
}

beforeAll(async () => {
  if (reachable) await sweep();
});

afterAll(async () => {
  if (reachable) await sweep();
  // The pool is shared with the other Postgres test files in this process; bun closes it on exit.
});

describe.skipIf(!reachable)('harness + Drizzle ports (Postgres)', () => {
  test('proposal round-trips exactly through proposal + proposal_op', async () => {
    const { propose } = env();
    const p = await propose();
    expect(p.status).toBe('pending_approval');
    expect(await new DrizzleProposalStore(db).get(p.id)).toEqual(p);
  });

  test('propose → needs_approval → operator 403 → approver 200 → second decision 409 → execute → audit → idempotent re-run', async () => {
    const { api, decide, propose, harness, ctx, erp } = env();

    // propose: medium risk, $1,200 → needs a human
    const p = await propose();
    expect(p.policy.outcome).toBe('needs_approval');
    expect(p.version).toBe(1);

    // detail over HTTP: ops with diff, policy reasons, status, version, no decision yet
    const detailRes = await api.request(`/api/proposals/${p.id}`, { headers: { authorization: 'Bearer operator' } });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as ProposalDetail;
    expect(detail).toMatchObject({ status: 'pending_approval', version: 1, totalValue: 1200, opCount: 1, workflowRunId: 'run-it-1', decision: null });
    expect(detail.ops[0]!.diff.length).toBeGreaterThan(0);
    expect(detail.policy.reasons.length).toBeGreaterThan(0);

    // operator can't decide
    expect((await decide(p.id, 'operator')).status).toBe(403);

    // approver can, exactly once
    const ok = await decide(p.id, 'approver');
    expect(ok.status).toBe(200);
    const decided = ((await ok.json()) as { proposal: ProposalDetail }).proposal;
    expect(decided).toMatchObject({ status: 'approved', version: 2 });
    expect(decided.decision).toMatchObject({ decision: 'approve', by: { kind: 'user', id: 'it-approver' }, reason: 'restock is due' });

    const [approvalRow] = await db.select().from(approval).where(inArray(approval.proposalId, [p.id]));
    expect(approvalRow).toMatchObject({ decision: 'approve', decidedById: 'it-approver', decidedByKind: 'user' });

    const again = await decide(p.id, 'approver2', { decision: 'reject' });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'decision_conflict' });

    // execute through the harness with the Drizzle store
    const done = await harness.execute({ ctx, proposalId: p.id });
    expect(done.status).toBe('executed');
    expect(done.ops[0]!.status).toBe('executed');
    expect(done.ops[0]!.result).toMatchObject({ deduplicated: false, attempts: 1, mismatches: [], error: null });
    expect(erp.writes).toBe(1);

    // audit events persisted, in order
    const auditRes = await api.request(`/api/audit-events?proposalId=${p.id}&order=asc`, { headers: { authorization: 'Bearer operator' } });
    const audit = ((await auditRes.json()) as { items: Array<{ type: string; seq: number; actor: { kind: string } }> }).items;
    const expectedTypes = [
      'proposal.created',
      'policy.evaluated',
      'proposal.decided',
      'proposal.execution_started',
      'op.executed',
      'op.verified',
      'proposal.executed',
    ];
    expect(audit.map((e) => e.type)).toEqual(expectedTypes);
    expect(audit.map((e) => e.seq)).toEqual([...audit.map((e) => e.seq)].sort((a, b) => a - b));
    expect(audit.find((e) => e.type === 'op.executed')?.actor.kind).toBe('system');

    // re-execute: zero writes, no new audit events, same final state
    const rerun = await harness.execute({ ctx, proposalId: p.id });
    expect(rerun.status).toBe('executed');
    expect(erp.writes).toBe(1);
    const auditAfter = await db.select().from(auditEvent).where(inArray(auditEvent.proposalId, [p.id]));
    expect(auditAfter.length).toBe(expectedTypes.length);
    expect(await harness.get(p.id)).toEqual(rerun);
  });

  test('concurrent approvers race on compare-and-set: exactly one wins', async () => {
    const { decide, propose } = env();
    const p = await propose();
    const results = await Promise.all([decide(p.id, 'approver'), decide(p.id, 'approver2', { decision: 'reject' })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const rows = await db.select().from(approval).where(inArray(approval.proposalId, [p.id]));
    expect(rows.length).toBe(1);
  });

  test('stale version: compareAndSet returns false and writes nothing', async () => {
    const { propose } = env();
    const p = await propose();
    const store = new DrizzleProposalStore(db);
    expect(await store.compareAndSet({ ...p, version: 6, title: 'stale' }, 5)).toBe(false);
    expect((await store.get(p.id))?.title).toBe('Restock Blue Dream');
  });
});
