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
  const emitted: Array<Parameters<ApiServices['webhooks']['emit']>[0]> = [];
  const ids = new Set<string>();
  // Inngest stand-in: dedupes by event id.
  const emit = mock(async (event: Parameters<ApiServices['webhooks']['emit']>[0]) => {
    if (ids.has(event.id)) return;
    ids.add(event.id);
    emitted.push(event);
  });
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
    webhooks: { distruSecret: SECRET, emit },
  };
  return { api: createApiRoutes(services), start, emit, emitted };
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
    const { api, emit } = setup();
    const raw = JSON.stringify(order);
    expect((await post(api, raw)).status).toBe(401);
    expect((await post(api, raw, signDistruBody(raw, 'other-secret'))).status).toBe(401);
    expect((await post(api, `${raw} `, signDistruBody(raw, SECRET))).status).toBe(401); // body tampered
    expect(emit).not.toHaveBeenCalled();
  });

  test("ORDER CREATE → the trigger's event (distru/order.created) + a context sync of the order; redeliveries dedupe", async () => {
    const { api, emitted } = setup();
    const raw = JSON.stringify(order);
    const res = await post(api, raw, signDistruBody(raw, SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: 'restock_requested', reason: null, contextSync: true });
    expect(emitted).toEqual([
      { name: 'distru/record.changed', id: 'distru.record_changed:ORDER:order-1:2026-11-19T12:00:00Z', data: { type: 'ORDER', id: 'order-1', event: 'CREATE', occurred_datetime: '2026-11-19T12:00:00Z' } },
      {
        name: 'distru/order.created',
        id: 'distru.order_created:ORDER:order-1:2026-11-19T12:00:00Z',
        data: { source: 'distru', eventId: expect.any(String), orderId: 'order-1', productIds: ['p-1', 'p-2'], locationIds: ['loc-1'] },
      },
    ]);
    // Distru retries the same change: same ids → nothing new queued.
    await post(api, raw, signDistruBody(raw, SECRET));
    expect(emitted.length).toBe(2);
    // A later change of the same order is a new event.
    const later = JSON.stringify({ ...order, occurred_datetime: '2026-11-19T12:05:00Z' });
    await post(api, later, signDistruBody(later, SECRET));
    expect(emitted.length).toBe(4);
  });

  test('PRODUCT / PURCHASE changes go to the context sync only; other types are ignored entirely', async () => {
    const { api, emitted } = setup();
    for (const type of ['PURCHASE', 'PRODUCT']) {
      const raw = JSON.stringify({ ...order, type, event: 'UPDATE' });
      const res = await post(api, raw, signDistruBody(raw, SECRET));
      expect(await res.json()).toMatchObject({ action: 'ignored', contextSync: true });
    }
    expect(emitted.map((e) => [e.name, (e.data as { type: string }).type])).toEqual([
      ['distru/record.changed', 'PURCHASE'],
      ['distru/record.changed', 'PRODUCT'],
    ]);
    const raw = JSON.stringify({ ...order, type: 'INVOICE' });
    expect(await (await post(api, raw, signDistruBody(raw, SECRET))).json()).toMatchObject({ action: 'ignored', contextSync: false });
    expect(emitted.length).toBe(2);
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
