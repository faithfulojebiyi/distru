import { describe, expect, mock, test } from 'bun:test';
import { createApiRoutes } from '../src/api/routes';
import { signDistruBody } from '../src/api/distru-webhook';
import type { ApiServices } from '../src/api/services';
import type { SessionUser } from '../src/auth/session';
import { stubServices } from './fixtures/stub-services';

const users: Record<string, SessionUser> = {
  operator: { id: 'u-op', email: 'operator@demo.dev', name: 'Op', role: 'operator' },
  approver: { id: 'u-ap', email: 'approver@demo.dev', name: 'Ap', role: 'approver' },
};
const SECRET = 'test-secret';

function setup() {
  const base = stubServices();
  const start = mock(async () => ({ runId: 'run-1', workflowId: 'restock' }));
  const requestRestock = mock(async (_trigger: Parameters<ApiServices['webhooks']['requestRestock']>[0]) => {});
  const services: ApiServices = {
    resolveSession: async (h) => users[h.get('authorization')?.replace('Bearer ', '') ?? ''] ?? null,
    checkDatabase: async () => true,
    proposals: { list: async () => [], get: async () => null, decide: async () => Promise.reject(new Error('unused')) },
    audit: { list: async () => [] },
    ...base,
    runs: { ...base.runs, start },
    connectors: {
      list: async () => [
        { id: 'distru', system: 'erp', description: 'Distru', health: { ok: true, detail: '3 locations reachable' }, readTools: 8, actions: 1, tools: [] },
      ],
    },
    webhooks: { distruSecret: SECRET, requestRestock },
  };
  return { api: createApiRoutes(services), start, requestRestock };
}

const auth = (as: string) => ({ authorization: `Bearer ${as}`, 'content-type': 'application/json' });

describe('POST /api/runs', () => {
  test('401 anonymous, 202 for operator and approver with the session user as trigger', async () => {
    const { api, start } = setup();
    expect((await api.request('/api/runs', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status).toBe(401);
    const res = await api.request('/api/runs', { method: 'POST', headers: auth('operator'), body: JSON.stringify({ scenarioNote: 'weekly' }) });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ runId: 'run-1', workflowId: 'restock', status: 'started' });
    expect(start).toHaveBeenCalledWith({ scenarioNote: 'weekly' }, users.operator);
    expect((await api.request('/api/runs', { method: 'POST', headers: auth('approver'), body: '{}' })).status).toBe(202);
  });

  test('503 when the engine cannot start the run', async () => {
    const { api, start } = setup();
    start.mockImplementationOnce(async () => Promise.reject(new Error('Inngest unreachable')));
    const res = await api.request('/api/runs', { method: 'POST', headers: auth('operator'), body: '{}' });
    expect(res.status).toBe(503);
  });

  test('GET /api/runs/:id 404 for an unknown run; GET /api/connectors lists health', async () => {
    const { api } = setup();
    expect((await api.request('/api/runs/nope', { headers: auth('operator') })).status).toBe(404);
    const res = await api.request('/api/connectors', { headers: auth('operator') });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ items: [{ id: 'distru', health: { ok: true } }] });
  });
});

describe('POST /api/webhooks/distru', () => {
  const order = {
    type: 'ORDER',
    event: 'CREATE',
    id: 'order-1',
    object: { location: { id: 'loc-1' }, items: [{ product: { id: 'p-1' } }, { product: { id: 'p-2' } }, { product: { id: 'p-1' } }] },
    changes: {},
    occurred_datetime: '2026-11-19T12:00:00Z',
  };
  const post = (api: ReturnType<typeof setup>['api'], body: string, signature?: string) =>
    api.request('/api/webhooks/distru', { method: 'POST', body, headers: { 'content-type': 'application/json', ...(signature ? { 'x-distru-signature': signature } : {}) } });

  test('401 without or with a wrong signature; nothing emitted', async () => {
    const { api, requestRestock } = setup();
    const raw = JSON.stringify(order);
    expect((await post(api, raw)).status).toBe(401);
    expect((await post(api, raw, signDistruBody(raw, 'other-secret'))).status).toBe(401);
    expect((await post(api, `${raw} `, signDistruBody(raw, SECRET))).status).toBe(401); // body tampered
    expect(requestRestock).not.toHaveBeenCalled();
  });

  test('ORDER CREATE → restock requested, scoped to the ordered products and location', async () => {
    const { api, requestRestock } = setup();
    const raw = JSON.stringify(order);
    const res = await post(api, raw, signDistruBody(raw, SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: 'restock_requested', reason: null });
    expect(requestRestock).toHaveBeenCalledTimes(1);
    expect(requestRestock.mock.calls[0]).toEqual([expect.objectContaining({ productIds: ['p-1', 'p-2'], locationIds: ['loc-1'], triggeredBy: expect.stringContaining('order-1') })]);
  });

  test('other events are acknowledged and ignored', async () => {
    const { api, requestRestock } = setup();
    const raw = JSON.stringify({ ...order, type: 'PURCHASE' });
    const res = await post(api, raw, signDistruBody(raw, SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ action: 'ignored' });
    expect(requestRestock).not.toHaveBeenCalled();
  });
});

describe('OpenAPI', () => {
  test('documents runs, connectors and the webhook with named schemas', async () => {
    const { api } = setup();
    const doc = (await (await api.request('/api/openapi.json')).json()) as { paths: Record<string, Record<string, unknown>>; components: { schemas: Record<string, unknown> } };
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/api/runs', '/api/runs/{id}', '/api/connectors', '/api/webhooks/distru']));
    expect(Object.keys(doc.paths['/api/runs']!)).toEqual(expect.arrayContaining(['get', 'post']));
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining(['RunSummary', 'RunDetail', 'RunStep', 'RunAgentCall', 'RunToolCall', 'StartRunRequest', 'StartRunResponse', 'ConnectorSummary', 'ConnectorList', 'WebhookResponse']),
    );
  });
});
