import {
  ConcurrentModificationError,
  DecisionConflictError,
  ForbiddenError,
  InputValidationError,
  NotFoundError,
  PolicyDeniedError,
} from '@ops/harness';
import { describe, expect, mock, test } from 'bun:test';
import { createApiRoutes } from '../src/api/routes';
import type { ProposalDetail } from '../src/api/schemas';
import type { ApiServices } from '../src/api/services';
import type { SessionUser } from '../src/auth/session';
import { stubServices } from './fixtures/stub-services';

const PROPOSAL_ID = '6f1c8a52-3f1e-4c55-9a43-2f4b7a1d9e10';
const now = new Date('2026-11-19T12:00:00Z').toISOString();

const users: Record<string, SessionUser> = {
  operator: { id: 'u-op', email: 'operator@demo.dev', name: 'Op', role: 'operator' },
  approver: { id: 'u-ap', email: 'approver@demo.dev', name: 'Ap', role: 'approver' },
};

const approverPrincipal = { kind: 'user' as const, id: 'u-ap', scopes: ['read' as const, 'propose' as const, 'approve' as const] };

const detail: ProposalDetail = {
  id: PROPOSAL_ID,
  version: 2,
  status: 'approved',
  title: 'Restock',
  createdBy: { kind: 'agent', id: 'planner', scopes: ['read', 'propose'] },
  policyOutcome: 'needs_approval',
  totalValue: 50,
  opCount: 0,
  actions: [],
  workflowRunId: null,
  createdAt: now,
  updatedAt: now,
  rationale: null,
  meta: {},
  ops: [],
  policy: { outcome: 'needs_approval', reasons: [] },
  decision: { decision: 'approve', by: approverPrincipal, reason: null, edited: false, at: now },
  execution: null,
};

function setup(outcome: ProposalDetail | Error = detail) {
  const decide = mock(async (): Promise<ProposalDetail> => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const services: ApiServices = {
    resolveSession: async (h) => users[h.get('authorization')?.replace('Bearer ', '') ?? ''] ?? null,
    checkDatabase: async () => true,
    proposals: { list: async () => [], get: async () => null, decide },
    audit: { list: async () => [] },
    ...stubServices(),
  };
  const api = createApiRoutes(services);
  const post = (body: unknown, as?: string, id = PROPOSAL_ID) =>
    api.request(`/api/proposals/${id}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(as ? { authorization: `Bearer ${as}` } : {}) },
      body: JSON.stringify(body),
    });
  return { api, decide, post };
}

describe('POST /api/proposals/:id/decision', () => {
  test('401 when anonymous, service never called', async () => {
    const { post, decide } = setup();
    expect((await post({ decision: 'approve' })).status).toBe(401);
    expect(decide).not.toHaveBeenCalled();
  });

  test('403 for an operator, service never called', async () => {
    const { post, decide } = setup();
    const res = await post({ decision: 'approve' }, 'operator');
    expect(res.status).toBe(403);
    expect(decide).not.toHaveBeenCalled();
  });

  test('200 for an approver; decision attributed to the session user', async () => {
    const { post, decide } = setup();
    const res = await post({ decision: 'approve', reason: 'looks right' }, 'approver');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { proposal: ProposalDetail };
    expect(body.proposal.decision?.by.id).toBe('u-ap');
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]).toEqual([
      PROPOSAL_ID,
      users.approver,
      { decision: 'approve', reason: 'looks right' },
    ] as never);
  });

  test('409 when the proposal already has a decision', async () => {
    const { post } = setup(new DecisionConflictError(PROPOSAL_ID, 'approved'));
    const res = await post({ decision: 'reject' }, 'approver');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'decision_conflict' });
  });

  test('409 on a concurrent modification', async () => {
    const { post } = setup(new ConcurrentModificationError('raced'));
    expect(await (await post({ decision: 'approve' }, 'approver')).json()).toMatchObject({ error: 'concurrent_modification' });
  });

  test('409 policy_denied carries the evaluation', async () => {
    const evaluation = { outcome: 'deny' as const, reasons: [{ rule: 'max_total_value', outcome: 'deny' as const, severity: 'error' as const, message: 'too much' }] };
    const { post } = setup(new PolicyDeniedError('denied', evaluation));
    const res = await post({ decision: 'approve', edits: [{ opIndex: 0, input: {} }] }, 'approver');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'policy_denied', message: 'denied', evaluation });
  });

  test('404 when the proposal does not exist', async () => {
    const { post } = setup(new NotFoundError('nope'));
    expect((await post({ decision: 'approve' }, 'approver')).status).toBe(404);
  });

  test('403 when the harness forbids (e.g. separation of duties)', async () => {
    const { post } = setup(new ForbiddenError('own proposal'));
    expect((await post({ decision: 'approve' }, 'approver')).status).toBe(403);
  });

  test('400 when the harness rejects the input', async () => {
    const { post } = setup(new InputValidationError('bad edit'));
    expect((await post({ decision: 'reject', edits: [{ opIndex: 0, input: {} }] }, 'approver')).status).toBe(400);
  });

  test('unknown errors are not swallowed', async () => {
    const { post } = setup(new Error('db down'));
    expect((await post({ decision: 'approve' }, 'approver')).status).toBe(500);
  });

  test('400 on an invalid body or id (after authorization)', async () => {
    const { post, decide } = setup();
    expect((await post({ decision: 'maybe' }, 'approver')).status).toBe(400);
    expect((await post({ decision: 'approve' }, 'approver', 'not-a-uuid')).status).toBe(400);
    expect(decide).not.toHaveBeenCalled();
  });

  test('operator gets 403 even with an invalid body (role checked first)', async () => {
    const { post } = setup();
    expect((await post({ decision: 'maybe' }, 'operator')).status).toBe(403);
  });
});

describe('GET /api/me and OpenAPI', () => {
  test('/api/me returns the session user', async () => {
    const { api } = setup();
    const res = await api.request('/api/me', { headers: { authorization: 'Bearer operator' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'u-op', email: 'operator@demo.dev', name: 'Op', role: 'operator' });
  });

  test('openapi.json lists custom routes with named component schemas', async () => {
    const { api } = setup();
    const doc = (await (await api.request('/api/openapi.json')).json()) as {
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/api/health', '/api/me', '/api/proposals', '/api/proposals/{id}', '/api/proposals/{id}/decision', '/api/audit-events', '/api/runs']),
    );
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining(['Me', 'ProposalSummary', 'ProposalDetail', 'DecisionRequest', 'DecisionResponse', 'AuditEvent', 'RunSummary', 'ProposalOp', 'FieldChange', 'PolicyEvaluation', 'PolicyReason', 'Decision', 'PolicyDeniedResponse']),
    );
  });
});
