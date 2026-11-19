import { describe, expect, test } from 'bun:test';
import { FakeClock, InMemoryAuditSink, ingestWebhook, Registry } from '@ops/harness';
import { distruConnector, DISTRU_ORDER_TRIGGER_ID, signDistruBody } from '../src';

const SECRET = 'mock-webhook-secret';
const registry = Registry.fromConnectors([distruConnector]);
const order = { type: 'ORDER', event: 'CREATE', id: 'ord-1', object: { location: { id: 'loc-1' }, items: [{ product: { id: 'p-1' } }, { product_id: 'p-2' }, { product: { id: 'p-1' } }] } };

async function ingest(body: unknown, signature?: string) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = new Headers(signature === undefined ? { 'x-distru-signature': signDistruBody(raw, SECRET) } : signature ? { 'x-distru-signature': signature } : {});
  const audit = new InMemoryAuditSink();
  const result = await ingestWebhook(registry, DISTRU_ORDER_TRIGGER_ID, raw, headers, { DISTRU_WEBHOOK_SECRET: SECRET }, { audit, clock: new FakeClock(new Date('2026-11-19T12:00:00Z')) });
  return { result, audit };
}

describe('distru.order_created trigger', () => {
  test('is registered on the connector', () => {
    expect(registry.trigger(DISTRU_ORDER_TRIGGER_ID)).toMatchObject({ source: 'distru', connectorId: 'distru', eventName: 'distru/order.created', delivery: 'webhook' });
  });

  test('ORDER CREATE → products + location, deduped by envelope id, audited', async () => {
    const { result, audit } = await ingest(order);
    expect(result).toMatchObject({
      status: 'accepted',
      event: { name: 'distru/order.created', id: 'distru.order_created:ORDER:CREATE:ord-1', data: { source: 'distru', orderId: 'ord-1', productIds: ['p-1', 'p-2'], locationIds: ['loc-1'] } },
    });
    expect(audit.events.map((e) => e.type)).toEqual(['trigger.received']);
  });

  test('other events are ignored; bad signatures 401; non-JSON / non-envelope 400', async () => {
    expect((await ingest({ ...order, event: 'UPDATE' })).result.status).toBe('ignored');
    const forged = await ingest(order, 'sha256=deadbeef');
    expect(forged.result).toMatchObject({ status: 'rejected', reason: 'invalid_signature', httpStatus: 401 });
    expect(forged.audit.events.map((e) => e.type)).toEqual(['trigger.rejected']);
    expect((await ingest(order, '')).result).toMatchObject({ status: 'rejected', httpStatus: 401 });
    expect((await ingest('not json')).result).toMatchObject({ status: 'rejected', reason: 'invalid_body', httpStatus: 400 });
    expect((await ingest({ hello: 1 })).result).toMatchObject({ status: 'rejected', reason: 'invalid_body', httpStatus: 400 });
  });
});
