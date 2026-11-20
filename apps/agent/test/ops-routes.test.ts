/**
 * Routes: MCP tokens (approver only, token shown once), undo (operator+, 409 undo_unavailable),
 * policy rules (approver-only PUT, validated against the engine's rules, audited), locations, and
 * the OpenAPI document (named components for every new schema).
 */
import { describe, expect, test } from 'bun:test';
import { InMemoryAuditSink, NotResumableError, UndoUnavailableError, type Principal } from '@ops/harness';
import { createApiRoutes } from '../src/api/routes';
import type { ProposalDetail } from '../src/api/schemas';
import type { ApiServices } from '../src/api/services';
import type { SessionUser } from '../src/auth/session';
import { APP_POLICY_RULES } from '../src/harness/policy';
import { createLocationsService } from '../src/services/locations';
import { createMcpTokenService, InMemoryMcpTokenStore } from '../src/services/mcp-tokens';
import { createPolicyRuleService, InMemoryPolicyRuleRepo } from '../src/services/policy-rules';
import { stubServices } from './fixtures/stub-services';

const users: Record<string, SessionUser> = {
  operator: { id: 'u-op', email: 'operator@demo.dev', name: 'Op', role: 'operator' },
  approver: { id: 'u-ap', email: 'approver@demo.dev', name: 'Ap', role: 'approver' },
};
const ID = '6f1c8a52-3f1e-4c55-9a43-2f4b7a1d9e10';

function setup(overrides: Partial<ApiServices> = {}) {
  const audit = new InMemoryAuditSink();
  const tokens = createMcpTokenService({ store: new InMemoryMcpTokenStore(), audit });
  const policy = createPolicyRuleService({
    repo: new InMemoryPolicyRuleRepo([{ key: 'max_total_value', params: { max: 25_000 }, enabled: true, description: 'cap', updatedAt: null }]),
    rules: APP_POLICY_RULES,
    audit,
  });
  let locationCalls = 0;
  const locations = createLocationsService(async () => {
    locationCalls++;
    return [{ id: 'loc-1', name: 'Oakland', address: '1 Main St', license: { license_number: 'C11-1' }, deleted_at: null }];
  });
  const services: ApiServices = {
    resolveSession: async (h) => users[h.get('authorization')?.replace('Bearer ', '') ?? ''] ?? null,
    checkDatabase: async () => true,
    proposals: { list: async () => [], get: async () => null, decide: async () => { throw new Error('unused'); } },
    audit: { list: async () => [] },
    ...stubServices(),
    mcpTokens: { create: (u, i) => tokens.create(u, i), list: () => tokens.list(), revoke: (u, id) => tokens.revoke(u, id), mcpUrl: 'http://localhost:4111/mcp' },
    policyRules: { list: () => policy.list(), available: () => policy.available(), replace: (a: Principal, r) => policy.replace(a, r) },
    locations,
    ...overrides,
  };
  const api = createApiRoutes(services);
  const call = (method: string, path: string, as?: string, body?: unknown) =>
    api.request(path, { method, headers: { 'content-type': 'application/json', ...(as ? { authorization: `Bearer ${as}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { api, call, audit, tokens, locationCalls: () => locationCalls };
}

describe('MCP tokens', () => {
  test('approver creates (token returned once, read implied), lists (no secret), revokes; operator gets 403', async () => {
    const { call, audit } = setup();
    expect((await call('POST', '/api/mcp-tokens', undefined, { name: 'x', scopes: ['read'] })).status).toBe(401);
    expect((await call('POST', '/api/mcp-tokens', 'operator', { name: 'x', scopes: ['read'] })).status).toBe(403);
    const res = await call('POST', '/api/mcp-tokens', 'approver', { name: 'Claude Code', scopes: ['propose'] });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { token: string; record: { id: string; scopes: string[]; prefix: string }; mcpUrl: string };
    expect(created.token).toStartWith('ops_mcp_');
    expect(created.record.scopes).toEqual(['read', 'propose']);
    expect(created.mcpUrl).toBe('http://localhost:4111/mcp');
    const list = (await (await call('GET', '/api/mcp-tokens', 'approver')).json()) as { items: Array<Record<string, unknown>> };
    expect(list.items).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(created.token);
    expect((await call('GET', '/api/mcp-tokens', 'operator')).status).toBe(403);
    const revoked = await call('DELETE', `/api/mcp-tokens/${created.record.id}`, 'approver');
    expect(revoked.status).toBe(200);
    expect(((await revoked.json()) as { revokedAt: string | null }).revokedAt).not.toBeNull();
    expect((await call('DELETE', `/api/mcp-tokens/${ID}`, 'approver')).status).toBe(404);
    expect(audit.types()).toEqual(['mcp_token.created', 'mcp_token.revoked']);
    expect((await call('POST', '/api/mcp-tokens', 'approver', { name: 'bad', scopes: ['root'] })).status).toBe(400);
  });
});

describe('undo route', () => {
  const undoDetail = { id: ID } as ProposalDetail;
  test('operator can propose an undo (201); 401 without session; 409 undo_unavailable with per-op reasons', async () => {
    let calledWith: unknown = null;
    const ok = setup({
      undo: {
        propose: async (id, user, input) => {
          calledWith = { id, user: user.id, input };
          return undoDetail;
        },
      },
    });
    expect((await ok.call('POST', `/api/proposals/${ID}/undo`, undefined, { reason: 'x' })).status).toBe(401);
    const res = await ok.call('POST', `/api/proposals/${ID}/undo`, 'operator', { reason: 'Vendor cancelled', opIndexes: [0, 2] });
    expect(res.status).toBe(201);
    expect(calledWith).toEqual({ id: ID, user: 'u-op', input: { reason: 'Vendor cancelled', opIndexes: [0, 2] } });
    expect((await ok.call('POST', `/api/proposals/${ID}/undo`, 'operator', { reason: '' })).status).toBe(400);

    const info = { available: false, reason: 'Only executed (or partly executed) proposals can be undone; this one is pending_approval.', ops: [], undoProposalId: null, undoOf: null, until: null };
    const unavailable = setup({
      undo: {
        propose: async () => {
          throw new UndoUnavailableError(info.reason, info);
        },
      },
    });
    const conflict = await unavailable.call('POST', `/api/proposals/${ID}/undo`, 'approver', { reason: 'oops' });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: 'undo_unavailable', message: info.reason, undo: info });
  });
});

describe('resume route', () => {
  test('approver only; 202 with queued flag; 409 not_resumable unless failed', async () => {
    const calls: unknown[] = [];
    const env = setup({
      resume: {
        request: async (id, user, input) => {
          calls.push({ id, user: user.id, input });
          if (id !== ID) throw new NotResumableError(id, 'executed');
          return { proposal: { id: ID, resumable: false } as ProposalDetail, queued: true };
        },
      },
    });
    expect((await env.call('POST', `/api/proposals/${ID}/resume`, undefined, {})).status).toBe(401);
    expect((await env.call('POST', `/api/proposals/${ID}/resume`, 'operator', {})).status).toBe(403);
    const ok = await env.call('POST', `/api/proposals/${ID}/resume`, 'approver', { reason: 'vendor released the hold' });
    expect(ok.status).toBe(202);
    expect(await ok.json()).toMatchObject({ queued: true, proposal: { id: ID } });
    expect(calls).toEqual([{ id: ID, user: 'u-ap', input: { reason: 'vendor released the hold' } }]);
    const other = '0f1c8a52-3f1e-4c55-9a43-2f4b7a1d9e11';
    const conflict = await env.call('POST', `/api/proposals/${other}/resume`, 'approver', {});
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: 'not_resumable', status: 'executed' });
  });
});

describe('policy rules', () => {
  test('GET for any user (rules + available rule types); PUT approver-only, validated, audited as policy.changed', async () => {
    const { call, audit } = setup();
    const list = (await (await call('GET', '/api/policy-rules', 'operator')).json()) as { items: Array<{ key: string }>; available: Array<{ key: string; paramsSchema: unknown }> };
    expect(list.items.map((r) => r.key)).toEqual(['max_total_value']);
    expect(list.available.map((r) => r.key)).toEqual(expect.arrayContaining(['max_total_value', 'auto_approve_below', 'email_recipient_domains']));

    expect((await call('PUT', '/api/policy-rules', 'operator', { rules: [] })).status).toBe(403);
    const bad = await call('PUT', '/api/policy-rules', 'approver', { rules: [{ key: 'max_total_value', params: { max: -1 } }, { key: 'nope', params: {} }] });
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as { error: string; issues: Array<{ key: string }> };
    expect(badBody.error).toBe('invalid_policy');
    expect(badBody.issues.map((i) => i.key)).toEqual(['max_total_value', 'nope']);
    expect(audit.ofType('policy.changed')).toHaveLength(0);

    const ok = await call('PUT', '/api/policy-rules', 'approver', {
      rules: [
        { key: 'max_total_value', params: { max: 10_000 } },
        { key: 'auto_approve_below', params: { amount: 250, max_risk: 'low' }, enabled: true, description: 'small stuff' },
      ],
    });
    expect(ok.status).toBe(200);
    const saved = (await ok.json()) as { items: Array<{ key: string; params: Record<string, unknown> }> };
    expect(saved.items.map((r) => r.key)).toEqual(['max_total_value', 'auto_approve_below']);
    const changes = audit.ofType('policy.changed');
    expect(changes.map((c) => c.data.key).sort()).toEqual(['auto_approve_below', 'max_total_value']);
    expect(changes.find((c) => c.data.key === 'max_total_value')!.data).toMatchObject({ before: { params: { max: 25_000 } }, after: { params: { max: 10_000 } } });
    expect(changes[0]!.actor).toMatchObject({ kind: 'user', id: 'u-ap' });
  });
});

describe('DEMO_MODE restrictions', () => {
  test('policy rules are read-only: GET works, PUT is 403 demo_read_only, nothing audited', async () => {
    const { call, audit } = setup({ demoMode: true });
    expect((await call('GET', '/api/policy-rules', 'approver')).status).toBe(200);
    const res = await call('PUT', '/api/policy-rules', 'approver', { rules: [{ key: 'max_total_value', params: { max: 1_000_000 } }] });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('demo_read_only');
    expect(body.message).toContain('read-only');
    expect(audit.ofType('policy.changed')).toHaveLength(0);
    // Still approver-only first: an operator gets the role error.
    expect((await call('PUT', '/api/policy-rules', 'operator', { rules: [] })).status).toBe(403);
  });

  test('MCP tokens: read / propose only; approve is 403 demo_restricted and no token is created', async () => {
    const { call, tokens } = setup({ demoMode: true });
    const refused = await call('POST', '/api/mcp-tokens', 'approver', { name: 'self-approver', scopes: ['propose', 'approve'] });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe('demo_restricted');
    expect(await tokens.list()).toHaveLength(0);
    expect((await call('POST', '/api/mcp-tokens', 'approver', { name: 'Claude Code', scopes: ['propose'] })).status).toBe(201);
  });

  test('outside demo mode an approve token can still be created', async () => {
    const { call } = setup();
    expect((await call('POST', '/api/mcp-tokens', 'approver', { name: 'ops bot', scopes: ['approve'] })).status).toBe(201);
  });
});

describe('locations', () => {
  test('lists own locations from Distru, cached', async () => {
    const env = setup();
    const res = await env.call('GET', '/api/locations', 'operator');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items).toEqual([{ id: 'loc-1', name: 'Oakland', licenseNumber: 'C11-1', address: '1 Main St' }]);
    await env.call('GET', '/api/locations', 'operator');
    expect(env.locationCalls()).toBe(1);
    expect((await env.call('GET', '/api/locations')).status).toBe(401);
  });
});

describe('OpenAPI', () => {
  test('new routes and named schemas are in /api/openapi.json', async () => {
    const { api } = setup();
    const doc = (await (await api.request('/api/openapi.json')).json()) as { paths: Record<string, Record<string, unknown>>; components: { schemas: Record<string, unknown> } };
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/api/mcp-tokens', '/api/mcp-tokens/{id}', '/api/proposals/{id}/undo', '/api/proposals/{id}/resume', '/api/policy-rules', '/api/locations']));
    expect(Object.keys(doc.paths['/api/policy-rules']!)).toEqual(expect.arrayContaining(['get', 'put']));
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining([
        'McpToken',
        'McpTokenList',
        'CreateMcpTokenRequest',
        'CreateMcpTokenResponse',
        'UndoRequest',
        'UndoResponse',
        'UndoUnavailableResponse',
        'UndoInfo',
        'UndoOpInfo',
        'PolicyRule',
        'PolicyRuleList',
        'PolicyRuleType',
        'PolicyRuleInput',
        'UpdatePolicyRulesRequest',
        'PolicyValidationError',
        'Location',
        'LocationList',
        'ProposalOpSummary',
        'OpConnector',
        'RunTotals',
        'RunToolCall',
      ]),
    );
    const toolCall = doc.components.schemas.RunToolCall as { properties: Record<string, unknown> };
    expect(Object.keys(toolCall.properties)).toEqual(expect.arrayContaining(['args', 'result']));
    const summary = doc.components.schemas.ProposalSummary as { properties: Record<string, unknown> };
    expect(Object.keys(summary.properties)).toEqual(expect.arrayContaining(['maxRisk', 'opSummaries', 'undoOf']));
    const event = doc.components.schemas.AuditEvent as { properties: Record<string, unknown> };
    expect(Object.keys(event.properties)).toEqual(expect.arrayContaining(['requestId', 'idempotencyKey', 'diff']));
    const run = doc.components.schemas.RunSummary as { properties: Record<string, unknown> };
    expect(Object.keys(run.properties)).toContain('totals');
  });
});
