import { beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { createMockServer, FAILED_TEST_SKU, INJECTION_SKU, INJECTION_TEXT, LOW_STOCK_SKUS, type MockServer } from '../src/app';

const NOW = '2026-11-19T12:00:00Z';
const AUTH = { Authorization: 'Bearer mock-token' };
const BASE = 'http://mock.test';

interface Hook {
  url: string;
  body: string;
  signature: string | null;
}

let mock: MockServer;
let hooks: Hook[];

function setup(opts: Parameters<typeof createMockServer>[0] = {}) {
  hooks = [];
  mock = createMockServer({
    now: NOW,
    webhookUrl: 'http://hooks.test/distru',
    webhookRetryDelaysMs: [],
    webhookFetch: async (url, init) => {
      hooks.push({ url, body: String(init.body), signature: new Headers(init.headers).get('x-distru-signature') });
      return new Response('ok');
    },
    ...opts,
  });
  return mock;
}

const get = (path: string, headers: Record<string, string> = AUTH) => mock.app.request(`${BASE}${path}`, { headers });
const post = (path: string, body: unknown, headers: Record<string, string> = AUTH) =>
  mock.app.request(`${BASE}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response): Promise<any> => r.json();

async function ids() {
  const s = mock.store;
  const vendor = [...s.companies.values()].find((c) => c.name === 'Golden State Edibles')!;
  const choc = [...s.products.values()].find((p) => p.sku === 'EDB-GUM-WM')!;
  const battery = [...s.products.values()].find((p) => p.sku === 'ACC-BAT-BLK')!;
  return { vendor, product: choc, battery, loc: s.ownLocationIds[0]!, otherLoc: s.ownLocationIds[1]! };
}

async function newPurchaseBody() {
  const { vendor, product, loc } = await ids();
  return {
    status: 'PENDING',
    company_id: vendor.id,
    location_id: loc,
    billing_location_id: loc,
    order_datetime: '2026-11-19T00:00:00Z',
    due_datetime: '2026-12-19T00:00:00Z',
    description: 'Agent restock',
    items: [{ product_id: product.id, location_id: loc, quantity: 96, price: 7 }],
  };
}

beforeEach(() => setup());

describe('auth + error envelope', () => {
  test('missing / wrong token → 401 envelope', async () => {
    const r = await get('/public/v1/products', {});
    expect(r.status).toBe(401);
    expect(await json(r)).toEqual({ errors: [{ message: 'Missing or invalid API token', pointer: ['base'] }] });
    expect((await get('/public/v1/products', { Authorization: 'Bearer nope' })).status).toBe(401);
  });

  test('unknown id → 404 envelope; unknown route → 404 envelope', async () => {
    const r = await get('/public/v1/purchases/does-not-exist');
    expect(r.status).toBe(404);
    expect((await json(r)).errors[0].pointer).toEqual(['base']);
    expect((await get('/public/v1/nope')).status).toBe(404);
  });

  test('invalid params → 400 with pointer', async () => {
    const r = await get('/public/v1/reports/inventory-velocity?service_level=101&below_reorder_point=maybe');
    expect(r.status).toBe(400);
    const body = await json(r);
    expect(body.errors.map((e: { pointer: string[] }) => e.pointer[0]).sort()).toEqual(['below_reorder_point', 'service_level']);
    const r2 = await get('/public/v1/orders?statuses[]=SHIPPED');
    expect(r2.status).toBe(400);
    expect((await json(r2)).errors[0].pointer).toEqual(['statuses']);
  });

  test('bad JSON body → 400 base', async () => {
    const r = await post('/public/v1/purchases', '{nope');
    expect(r.status).toBe(400);
    expect((await json(r)).errors[0].pointer).toEqual(['base']);
  });

  test('inventory requires groupings[] with PRODUCT', async () => {
    const r = await get('/public/v1/inventory');
    expect(r.status).toBe(400);
    expect((await json(r)).errors[0].pointer).toEqual(['groupings']);
  });
});

describe('pagination', () => {
  test('products: 25 per page, next_page carries filters, follows until null', async () => {
    const first = await json(await get('/public/v1/products?is_active=true'));
    expect(first.data).toHaveLength(25);
    expect(first.next_page).toStartWith(`${BASE}/public/v1/products?is_active=true&page[after]=`);
    const second = await json(await mock.app.request(first.next_page, { headers: AUTH }));
    expect(second.next_page).toBeNull();
    const all = [...first.data, ...second.data];
    expect(all.length).toBe(42); // 43 products, one inactive
    expect(new Set(all.map((p: { id: string }) => p.id)).size).toBe(42);
    expect(all.every((p: { is_active: boolean }) => p.is_active)).toBe(true);
  });

  test('orders paginate deep and every page is newest-first', async () => {
    let url: string | null = `${BASE}/public/v1/orders`;
    let count = 0;
    let pages = 0;
    let last = '9999';
    while (url) {
      const page: { data: { order_datetime: string }[]; next_page: string | null } = await json(await mock.app.request(url, { headers: AUTH }));
      for (const o of page.data) {
        expect(o.order_datetime <= last).toBe(true);
        last = o.order_datetime;
      }
      count += page.data.length;
      pages++;
      url = page.next_page;
    }
    expect(count).toBe(mock.store.orders.size);
    expect(pages).toBe(Math.ceil(count / 25));
  });

  test('invalid cursor → 400', async () => {
    const r = await get('/public/v1/products?page[after]=garbage');
    expect(r.status).toBe(400);
    expect((await json(r)).errors[0].pointer).toEqual(['page']);
  });

  test('array filters use bracket syntax', async () => {
    const { product, battery } = await ids();
    const r = await json(await get(`/public/v1/products?ids[]=${product.id}&ids[]=${battery.id}`));
    expect(r.data.map((p: { sku: string }) => p.sku).sort()).toEqual(['ACC-BAT-BLK', 'EDB-GUM-WM']);
  });
});

describe('inventory velocity report', () => {
  test('below_reorder_point=true returns exactly the seeded low-stock SKUs', async () => {
    for (const lead of [7, 14, 21]) {
      const r = await json(await get(`/public/v1/reports/inventory-velocity?below_reorder_point=true&lead_time_days=${lead}`));
      expect(r.data.map((x: { sku: string }) => x.sku).sort()).toEqual([...LOW_STOCK_SKUS].sort());
      expect(r.meta.report).toBe('inventory_velocity');
    }
  });

  test('rows are schema-shaped and figures are consistent', async () => {
    const r = await json(await get('/public/v1/reports/inventory-velocity?lead_time_days=14&target_days_of_supply=30'));
    const row = r.data.find((x: { sku: string }) => x.sku === 'FLW-BD-35');
    expect(row.below_reorder_point).toBe(true);
    expect(['LATE', 'ORDER_NOW', 'ORDER_SOON']).toContain(row.reorder_status);
    const rate = Number(row.average_daily_sold);
    expect(rate).toBeCloseTo(0.5 * Number(row.average_daily_sold_30) + 0.5 * Number(row.average_daily_sold_365), 3);
    expect(Number(row.days_of_supply)).toBeCloseTo(Number(row.quantity_available) / rate, 0);
    expect(Number(row.suggested_order_quantity) % Number(row.units_per_case)).toBe(0);
    expect(row.last_sold_at).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}$/);
    // rows sorted by reorder_by_date, nulls last
    const dates = r.data.map((x: { reorder_by_date: string | null }) => (x.reorder_by_date ? Date.parse(x.reorder_by_date) : Infinity));
    expect([...dates].sort((a, b) => a - b)).toEqual(dates);
    expect(r.meta.columns.some((c: { key: string }) => c.key === 'suggested_order_quantity')).toBe(true);
  });

  test('below_reorder_point=false excludes them; omitting lead_time → UNKNOWN and filter keeps nothing', async () => {
    const above = await json(await get('/public/v1/reports/inventory-velocity?below_reorder_point=false&lead_time_days=14'));
    expect(above.data.some((x: { sku: string }) => LOW_STOCK_SKUS.includes(x.sku))).toBe(false);
    expect(above.data.length).toBeGreaterThan(20);
    const noLead = await json(await get('/public/v1/reports/inventory-velocity'));
    expect(noLead.data.every((x: { reorder_status: string }) => x.reorder_status === 'UNKNOWN')).toBe(true);
    const noLeadBelow = await json(await get('/public/v1/reports/inventory-velocity?below_reorder_point=true'));
    expect(noLeadBelow.data).toEqual([]);
  });

  test('vendor_ids[] filter + NO_RECENT_SALES + incoming from open PO', async () => {
    const { vendor } = await ids();
    const r = await json(await get(`/public/v1/reports/inventory-velocity?lead_time_days=14&vendor_ids[]=${vendor.id}`));
    expect(r.data.every((x: { vendor_id: string }) => x.vendor_id === vendor.id)).toBe(true);
    const choc = r.data.find((x: { sku: string }) => x.sku === 'EDB-CHO-DK');
    expect(choc.quantity_incoming).toBe('48');
    const all = await json(await get('/public/v1/reports/inventory-velocity?lead_time_days=14'));
    expect(all.data.find((x: { sku: string }) => x.sku === 'FLW-PE-14').reorder_status).toBe('NO_RECENT_SALES');
  });

  test('no-reorder-needed scenario has nothing below reorder point', async () => {
    expect((await post('/__mock/reset', { scenario: 'no-reorder-needed' })).status).toBe(200);
    const r = await json(await get('/public/v1/reports/inventory-velocity?below_reorder_point=true&lead_time_days=21'));
    expect(r.data).toEqual([]);
  });
});

describe('POST /purchases upsert', () => {
  test('create → 200, readable by id, listed, webhook signed', async () => {
    const r = await post('/public/v1/purchases', await newPurchaseBody());
    expect(r.status).toBe(200);
    const { data } = await json(r);
    expect(data.id).toBeString();
    expect(data.status).toBe('PENDING');
    expect(data.total).toBe('672.00');
    expect(data.items[0].quantity).toBe('96');
    expect(data.items[0].product.sku).toBe('EDB-GUM-WM');
    const got = await json(await get(`/public/v1/purchases/${data.id}`));
    expect(got.data).toEqual(data);
    const listed = await json(await get(`/public/v1/purchases?ids[]=${data.id}`));
    expect(listed.data).toHaveLength(1);

    await mock.webhooks.idle();
    expect(hooks).toHaveLength(1);
    const hook = JSON.parse(hooks[0]!.body);
    expect(hook).toMatchObject({ type: 'PURCHASE', event: 'CREATE', id: data.id, changes: {} });
    expect(hook.object.id).toBe(data.id);
    expect(hooks[0]!.signature).toBe(`sha256=${createHmac('sha256', 'mock-webhook-secret').update(hooks[0]!.body).digest('hex')}`);
  });

  test('created PO raises quantity_incoming in the velocity report', async () => {
    await post('/public/v1/purchases', await newPurchaseBody());
    const r = await json(await get('/public/v1/reports/inventory-velocity?lead_time_days=14&search=EDB-GUM-WM'));
    expect(r.data[0].quantity_incoming).toBe('96');
  });

  test('sparse update: omitted fields unchanged, null clears, changes in webhook', async () => {
    const { data: created } = await json(await post('/public/v1/purchases', await newPurchaseBody()));
    const r = await post('/public/v1/purchases', { id: created.id, status: 'PROCESSING', description: null });
    expect(r.status).toBe(200);
    const { data } = await json(r);
    expect(data.status).toBe('PROCESSING');
    expect(data.description).toBeNull();
    expect(data.items).toEqual(created.items);
    expect(data.company.id).toBe(created.company.id);
    await mock.webhooks.idle();
    const update = JSON.parse(hooks[1]!.body);
    expect(update.event).toBe('UPDATE');
    expect(update.changes.status).toEqual({ before: 'PENDING', after: 'PROCESSING' });
    expect(update.changes.description).toEqual({ before: 'Agent restock', after: null });
  });

  test('items replace the set: {id} keeps, new rows add, omitted rows delete', async () => {
    const { product, loc } = await ids();
    const { data: created } = await json(await post('/public/v1/purchases', await newPurchaseBody()));
    const keepId = created.items[0].id;
    const other = [...mock.store.products.values()].find((p) => p.sku === 'EDB-GUM-SB')!;
    const added = await json(
      await post('/public/v1/purchases', { id: created.id, items: [{ id: keepId }, { product_id: other.id, location_id: loc, quantity: 48, price: 7 }] }),
    );
    expect(added.data.items.map((i: { id: string }) => i.id)[0]).toBe(keepId);
    expect(added.data.items).toHaveLength(2);
    const patched = await json(await post('/public/v1/purchases', { id: created.id, items: [{ id: keepId, quantity: 144 }] }));
    expect(patched.data.items).toHaveLength(1);
    expect(patched.data.items[0]).toMatchObject({ id: keepId, quantity: '144', price: '7.00' });
    expect(patched.data.items[0].product.id).toBe(product.id);
  });

  test('unknown id → 404', async () => {
    const r = await post('/public/v1/purchases', { id: 'nope', status: 'PENDING' });
    expect(r.status).toBe(404);
  });

  test('create validation: required fields, pointers into items', async () => {
    const { product, otherLoc, loc } = await ids();
    const r = await post('/public/v1/purchases', {
      status: 'PENDING',
      location_id: loc,
      items: [{ product_id: product.id, location_id: otherLoc, quantity: 0, price: -1 }, { quantity: 5 }],
    });
    expect(r.status).toBe(400);
    const { errors } = await json(r);
    const ptrs = errors.map((e: { pointer: (string | number)[] }) => e.pointer.join('.'));
    expect(ptrs).toEqual(
      expect.arrayContaining(['company_id', 'billing_location_id', 'order_datetime', 'due_datetime', 'items.0.quantity', 'items.0.price', 'items.0.location_id', 'items.1.price', 'items.1']),
    );
    expect((await post('/public/v1/purchases', { company_id: 'x' })).status).toBe(400); // status required
  });

  test('Distru rules: batch_id on package-tracked, mixed tracking, COMPLETED needs transfer, no back to DRAFT', async () => {
    const base = await newPurchaseBody();
    const { battery, loc } = await ids();
    const batch = [...mock.store.batches.values()].find((b) => b.product_id === base.items[0]!.product_id)!;
    const withBatch = await json(await post('/public/v1/purchases', { ...base, items: [{ ...base.items[0], batch_id: batch.id }] }));
    expect(withBatch.errors[0].pointer).toEqual(['items', 0, 'batch_id']);
    const mixed = await json(await post('/public/v1/purchases', { ...base, items: [...base.items, { product_id: battery.id, location_id: loc, quantity: 50, price: 4 }] }));
    expect(mixed.errors[0].pointer).toEqual(['items']);
    const completed = await json(await post('/public/v1/purchases', { ...base, status: 'COMPLETED' }));
    expect(completed.errors[0].pointer).toEqual(['status']);
    const { data } = await json(await post('/public/v1/purchases', base));
    const back = await json(await post('/public/v1/purchases', { id: data.id, status: 'DRAFT' }));
    expect(back.errors[0]).toEqual({ message: 'cannot move back to DRAFT', pointer: ['status'] });
  });

  test('DRAFT needs only status; hidden from default list, visible with statuses[]=DRAFT', async () => {
    const r = await json(await post('/public/v1/purchases', { status: 'DRAFT' }));
    expect(r.data.status).toBe('DRAFT');
    const def = await json(await get(`/public/v1/purchases?ids[]=${r.data.id}`));
    expect(def.data).toHaveLength(0);
    const drafts = await json(await get(`/public/v1/purchases?ids[]=${r.data.id}&statuses[]=DRAFT`));
    expect(drafts.data).toHaveLength(1);
  });

  test('completing a product-tracked PO receives stock', async () => {
    const { battery, vendor, loc } = await ids();
    const before = Number((await json(await get(`/public/v1/products/${battery.id}`))).data.quantity_active);
    const r = await post('/public/v1/purchases', {
      status: 'COMPLETED',
      company_id: vendor.id,
      location_id: loc,
      billing_location_id: loc,
      order_datetime: '2026-11-19T00:00:00Z',
      due_datetime: '2026-12-19T00:00:00Z',
      items: [{ product_id: battery.id, location_id: loc, quantity: 50, price: 4 }],
    });
    expect(r.status).toBe(200);
    const after = Number((await json(await get(`/public/v1/products/${battery.id}`))).data.quantity_active);
    expect(after - before).toBe(50);
  });
});

describe('scenarios + compliance data', () => {
  test('default: failed lab test is visible via test-results, batches and metrc packages', async () => {
    const seed = mock.store.summary!;
    expect(seed.failed_lab_test?.sku).toBe(FAILED_TEST_SKU);
    const tr = await json(await get(`/public/v1/test-results?batch_ids[]=${seed.failed_lab_test!.batch_id}`));
    expect(tr.data[0].name).toContain('FAILED');
    expect(tr.data[0].additional_test_results.myclobutanil_ug_per_g).toBe('0.920');
    const batch = await json(await get(`/public/v1/batches/${seed.failed_lab_test!.batch_id}`));
    expect(batch.data.primary_test_result.name).toContain('FAILED');
    const pk = await json(await get('/public/v1/metrc/packages?statuses[]=ONHOLD'));
    expect(pk.data.length).toBeGreaterThan(0);
    expect(pk.data.every((p: { lab_testing_state: string }) => p.lab_testing_state === 'TestFailed')).toBe(true);
  });

  test('default: injection text in product description', async () => {
    const seed = mock.store.summary!;
    const p = await json(await get(`/public/v1/products/${seed.prompt_injection!.product_id}`));
    expect(p.data.sku).toBe(INJECTION_SKU);
    expect(p.data.description).toContain(INJECTION_TEXT);
  });

  test('clean scenario has no hazards; ids are stable across scenarios', async () => {
    const injectedId = mock.store.summary!.prompt_injection!.product_id;
    await post('/__mock/reset', { scenario: 'clean' });
    const state = await json(await mock.app.request(`${BASE}/__mock/state`));
    expect(state.seed.failed_lab_test).toBeNull();
    expect(state.seed.prompt_injection).toBeNull();
    const p = await json(await get(`/public/v1/products/${injectedId}`));
    expect(p.data.description).not.toContain('SYSTEM:');
    const pk = await json(await get('/public/v1/metrc/packages?statuses[]=ONHOLD'));
    expect(pk.data).toHaveLength(0);
  });

  test('reset rejects unknown scenarios; reset discards writes', async () => {
    expect((await post('/__mock/reset', { scenario: 'nope' })).status).toBe(400);
    const { data } = await json(await post('/public/v1/purchases', await newPurchaseBody()));
    await post('/__mock/reset', {});
    expect((await get(`/public/v1/purchases/${data.id}`)).status).toBe(404);
  });
});

describe('mock control plane', () => {
  test('429 simulation with Retry-After', async () => {
    const cfg = await post('/__mock/config', { rate_limit: { fail_next: 2, retry_after: 3 } });
    expect(cfg.status).toBe(200);
    const r1 = await get('/public/v1/products');
    expect(r1.status).toBe(429);
    expect(r1.headers.get('Retry-After')).toBe('3');
    expect((await json(r1)).errors[0].pointer).toEqual(['base']);
    expect((await get('/public/v1/products')).status).toBe(429);
    expect((await get('/public/v1/products')).status).toBe(200);
  });

  test('simulate order creates an open order and fires ORDER CREATE', async () => {
    const r = await post('/__mock/simulate/order', { items: [{ sku: 'FLW-BD-35', quantity: 30 }] });
    expect(r.status).toBe(201);
    const { data } = await json(r);
    expect(data.status).toBe('PENDING');
    expect(data.items[0].product.sku).toBe('FLW-BD-35');
    const open = await json(await get(`/public/v1/orders?ids[]=${data.id}&statuses[]=PENDING`));
    expect(open.data).toHaveLength(1);
    await mock.webhooks.idle();
    const orderHook = hooks.map((h) => JSON.parse(h.body)).find((h) => h.type === 'ORDER');
    expect(orderHook).toMatchObject({ type: 'ORDER', event: 'CREATE', id: data.id });
    const state = await json(await mock.app.request(`${BASE}/__mock/state`));
    expect(state.webhooks.find((w: { type: string }) => w.type === 'ORDER')).toMatchObject({ type: 'ORDER', status: 200 });
    // the new order reserves stock: PRODUCT webhooks carry the company-wide quantity change
    const productHook = hooks.map((h) => JSON.parse(h.body)).find((h) => h.type === 'PRODUCT' && h.id === data.items[0].product.id);
    expect(productHook.changes.quantity_reserved.after).not.toBe(productHook.changes.quantity_reserved.before);
  });

  test('seed is deterministic for a given day', () => {
    const a = createMockServer({ now: NOW }).store;
    const b = createMockServer({ now: NOW }).store;
    expect([...a.products.keys()]).toEqual([...b.products.keys()]);
    expect([...a.orders.values()].map((o) => o.items.length)).toEqual([...b.orders.values()].map((o) => o.items.length));
  });
});
