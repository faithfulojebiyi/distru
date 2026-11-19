import { describe, expect, mock, test } from 'bun:test';
import { createApiRoutes } from '../src/api/routes';
import type { ApiServices, DecideResult } from '../src/api/services';
import type { SessionUser } from '../src/auth/session';

const PROPOSAL_ID = '6f1c8a52-3f1e-4c55-9a43-2f4b7a1d9e10';
const now = new Date('2026-11-19T12:00:00Z').toISOString();

const users: Record<string, SessionUser> = {
  operator: { id: 'u-op', email: 'operator@demo.dev', name: 'Op', role: 'operator' },
  approver: { id: 'u-ap', email: 'approver@demo.dev', name: 'Ap', role: 'approver' },
};

function setup(decideResult?: DecideResult) {
  const decide = mock(async (): Promise<DecideResult> =>
    decideResult ?? {
      ok: true,
      proposal: {
        id: PROPOSAL_ID,
        title: 'Restock',
        summary: null,
        status: 'approved',
        workflowRunId: null,
        createdByType: 'agent',
        createdByUserId: null,
        opCount: 1,
        createdAt: now,
        updatedAt: now,
      },
      approval: {
        id: '0b7d7c1e-8f7a-4d0b-9a55-1d3c2b4a5e6f',
        proposalId: PROPOSAL_ID,
        decision: 'approved',
        decidedBy: 'u-ap',
        reason: null,
        decidedAt: now,
      },
    },
  );
  const services: ApiServices = {
    resolveSession: async (h) => users[h.get('authorization')?.replace('Bearer ', '') ?? ''] ?? null,
    checkDatabase: async () => true,
    proposals: { list: async () => [], get: async () => null, decide },
    audit: { list: async () => [] },
    runs: { list: async () => [] },
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
    expect((await post({ decision: 'approved' })).status).toBe(401);
    expect(decide).not.toHaveBeenCalled();
  });

  test('403 for an operator, service never called', async () => {
    const { post, decide } = setup();
    const res = await post({ decision: 'approved' }, 'operator');
    expect(res.status).toBe(403);
    expect(decide).not.toHaveBeenCalled();
  });

  test('200 for an approver; decision attributed to the session user', async () => {
    const { post, decide } = setup();
    const res = await post({ decision: 'approved', reason: 'looks right' }, 'approver');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approval: { decidedBy: string } };
    expect(body.approval.decidedBy).toBe('u-ap');
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]).toEqual([
      PROPOSAL_ID,
      users.approver,
      { decision: 'approved', reason: 'looks right' },
    ] as never);
  });

  test('409 when the proposal already has a decision', async () => {
    const { post } = setup({ ok: false, reason: 'already_decided' });
    expect((await post({ decision: 'rejected' }, 'approver')).status).toBe(409);
  });

  test('404 when the proposal does not exist', async () => {
    const { post } = setup({ ok: false, reason: 'not_found' });
    expect((await post({ decision: 'approved' }, 'approver')).status).toBe(404);
  });

  test('400 on an invalid body or id (after authorization)', async () => {
    const { post, decide } = setup();
    expect((await post({ decision: 'maybe' }, 'approver')).status).toBe(400);
    expect((await post({ decision: 'approved' }, 'approver', 'not-a-uuid')).status).toBe(400);
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
      expect.arrayContaining(['Me', 'ProposalSummary', 'ProposalDetail', 'DecisionRequest', 'DecisionResponse', 'AuditEvent', 'RunSummary']),
    );
  });
});
