/** The generated @ops/distru-client running against the mock in-process (no network). */
import { describe, expect, test } from 'bun:test';
import { buildPurchaseOrder, createDistruClient, DistruApiError, findPurchaseByIdempotencyKey, upsertPurchaseVerified } from '@ops/distru-client';
import { createMockServer, LOW_STOCK_SKUS } from '../src/app';

function setup() {
  const mock = createMockServer({ now: '2026-11-19T12:00:00Z' });
  const sleeps: number[] = [];
  const client = createDistruClient({
    baseUrl: 'http://mock.test',
    token: 'mock-token',
    fetch: (url, init) => Promise.resolve(mock.app.request(url, init)),
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { mock, client, sleeps };
}

describe('client ↔ mock', () => {
  test('velocity report → below-reorder rows typed end to end', async () => {
    const { client } = setup();
    const report = await client.getInventoryVelocityReport({ below_reorder_point: true, lead_time_days: 14 });
    expect(report.data.map((r) => r.sku).sort()).toEqual([...LOW_STOCK_SKUS].sort());
  });

  test('paginate follows next_page across all products and orders', async () => {
    const { client, mock } = setup();
    const products = await client.listAll(client.listProducts, {});
    expect(products).toHaveLength(43);
    let n = 0;
    for await (const o of client.paginate(client.listOrders, { statuses: ['PENDING', 'PROCESSING', 'READY_TO_SHIP'] })) {
      expect(['PENDING', 'PROCESSING', 'READY_TO_SHIP']).toContain(o.status);
      n++;
    }
    expect(n).toBe([...mock.store.orders.values()].filter((o) => ['PENDING', 'PROCESSING', 'READY_TO_SHIP'].includes(o.status)).length);
  });

  test('inventory with array params (groupings[])', async () => {
    const { client } = setup();
    const rows = await client.listAll(client.listInventory, { groupings: ['PRODUCT', 'LOCATION'] });
    expect(rows.length).toBeGreaterThan(40);
    expect(rows[0]).toHaveProperty('location_id');
  });

  test('upsert + verify + idempotency lookup', async () => {
    const { client } = setup();
    const [row] = (await client.getInventoryVelocityReport({ below_reorder_point: true, lead_time_days: 14, search: 'EDB-GUM-WM' })).data;
    const locations = await client.listAll(client.listLocations, {});
    const body = buildPurchaseOrder({
      vendorId: row!.vendor_id,
      locationId: locations[0]!.id,
      lines: [{ productId: row!.product_id, quantity: Number(row!.suggested_order_quantity), unitPrice: 7 }],
      idempotencyKey: 'run-42:op-0',
    });
    const res = await upsertPurchaseVerified(client, body);
    expect(res.mismatches).toEqual([]);
    expect(res.created).toBe(true);
    const found = await findPurchaseByIdempotencyKey(client, 'run-42:op-0', { companyId: row!.vendor_id });
    expect(found?.id).toBe(res.purchase.id);
  });

  test('validation error surfaces as DistruApiError with pointers', async () => {
    const { client } = setup();
    const e = await client.upsertPurchase({ status: 'PENDING' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DistruApiError);
    expect((e as DistruApiError).status).toBe(400);
    expect((e as DistruApiError).errorsAt('company_id')).toHaveLength(1);
    const nf = (await client.getPurchase('missing').catch((x: unknown) => x)) as DistruApiError;
    expect(nf.isNotFound).toBe(true);
  });

  test('client retries simulated 429s using Retry-After', async () => {
    const { client, mock, sleeps } = setup();
    mock.rateLimit.fail_next = 2;
    mock.rateLimit.retry_after = 1;
    const page = await client.listCompanies();
    expect(page.data?.length).toBeGreaterThan(0);
    expect(sleeps).toEqual([1000, 1000]);
  });
});
