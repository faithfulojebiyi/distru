import { describe, expect, test } from 'bun:test';
import { FakeClock, InMemoryAuditSink, ingestWebhook, Registry, triggerSource } from '@ops/harness';
import { createDistruOrderCreatedTrigger, distruConnector, distruTimestampProblem, DISTRU_ORDER_TRIGGER_ID, signDistruBody } from '../src';

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

  test('dedupe key is (type, id, occurred_datetime): a retry of the same change has the same event id', async () => {
    const at = '2026-11-19T12:00:00Z';
    const a = await ingest({ ...order, occurred_datetime: at });
    const retry = await ingest({ ...order, occurred_datetime: at });
    const later = await ingest({ ...order, occurred_datetime: '2026-11-19T12:05:00Z' });
    expect(a.result).toMatchObject({ status: 'accepted', event: { id: `distru.order_created:ORDER:ord-1:${at}` } });
    expect(retry.result).toMatchObject({ event: { id: `distru.order_created:ORDER:ord-1:${at}` } });
    expect(later.result).toMatchObject({ event: { id: 'distru.order_created:ORDER:ord-1:2026-11-19T12:05:00Z' } });
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

describe('replay protection (occurred_datetime tolerance)', () => {
  const NOW = new Date('2026-11-19T12:00:00Z');
  const strict = triggerSource([createDistruOrderCreatedTrigger({ toleranceSeconds: 300, now: () => NOW })]);
  async function ingestStrict(body: unknown) {
    const raw = JSON.stringify(body);
    const headers = new Headers({ 'x-distru-signature': signDistruBody(raw, SECRET) });
    const audit = new InMemoryAuditSink();
    return { result: await ingestWebhook(strict, DISTRU_ORDER_TRIGGER_ID, raw, headers, { DISTRU_WEBHOOK_SECRET: SECRET }, { audit, clock: new FakeClock(NOW) }), audit };
  }

  test('a fresh, correctly signed delivery is accepted', async () => {
    expect((await ingestStrict({ ...order, occurred_datetime: '2026-11-19T11:58:30Z' })).result.status).toBe('accepted');
    // Small clock skew the other way is fine too.
    expect((await ingestStrict({ ...order, occurred_datetime: '2026-11-19T12:01:00Z' })).result.status).toBe('accepted');
  });

  test('a replayed (validly signed) delivery older than the tolerance is rejected and audited', async () => {
    const { result, audit } = await ingestStrict({ ...order, occurred_datetime: '2026-11-19T11:54:59Z' });
    expect(result).toMatchObject({ status: 'rejected', reason: 'stale_delivery', httpStatus: 401 });
    expect(result.status === 'rejected' && result.message).toContain('old');
    expect(audit.events.map((e) => e.type)).toEqual(['trigger.rejected']);
  });

  test('far-future, missing or unparseable timestamps are rejected while the check is on', async () => {
    expect((await ingestStrict({ ...order, occurred_datetime: '2026-11-19T12:10:00Z' })).result).toMatchObject({ status: 'rejected', reason: 'stale_delivery' });
    expect((await ingestStrict(order)).result).toMatchObject({ status: 'rejected', reason: 'stale_delivery' });
    expect((await ingestStrict({ ...order, occurred_datetime: 'yesterday' })).result).toMatchObject({ status: 'rejected', reason: 'stale_delivery' });
  });

  test('tolerance 0 (default, and the connector\'s registered trigger) skips the check', () => {
    expect(distruTimestampProblem('2020-01-01T00:00:00Z', 0, NOW)).toBeNull();
    expect(distruTimestampProblem(undefined, 0, NOW)).toBeNull();
    expect(distruTimestampProblem('2026-11-19T11:55:00Z', 300, NOW)).toBeNull();
    expect(distruTimestampProblem('2026-11-19T11:54:00Z', 300, NOW)).toContain('360s old');
  });
});
