/** REST additions: list budget (token bucket), PDF limit, tasks/users/custom fields/deleted records/history, webhooks. */
import { describe, expect, test } from 'bun:test';
import { createMockServer, type MockOptions } from '../src/app';

const NOW = '2026-11-19T12:00:00Z';
const BASE = 'http://mock.test';
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function setup(opts: MockOptions = {}) {
  let now = Date.parse('2026-11-19T12:00:00Z');
  const clock = { now: () => now, advance: (ms: number) => void (now += ms) };
  const mock = createMockServer({ now: NOW, clock: clock.now, ...opts });
  const req = (path: string, init: RequestInit = {}) =>
    mock.app.request(`${BASE}${path}`, { ...init, headers: { Authorization: 'Bearer mock-token', 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const get = (path: string) => req(`/public/v1${path}`);
  const post = (path: string, body: unknown) => req(`/public/v1${path}`, { method: 'POST', body: JSON.stringify(body) });
  const config = (body: unknown) => req('/__mock/config', { method: 'POST', body: JSON.stringify(body) });
  const s = mock.store;
  const vendor = [...s.companies.values()].find((c) => c.name === 'Golden State Edibles')!;
  const gummy = [...s.products.values()].find((p) => p.sku === 'EDB-GUM-WM')!;
  const loc = s.ownLocationIds[0]!;
  const poBody = (extra: Json = {}) => ({
    status: 'PENDING',
    company_id: vendor.id,
    location_id: loc,
    billing_location_id: loc,
    order_datetime: '2026-11-19T00:00:00Z',
    due_datetime: '2026-12-19T00:00:00Z',
    items: [{ product_id: gummy.id, location_id: loc, quantity: 24, price: 7 }],
    ...extra,
  });
  return { mock, clock, req, get, post, config, poBody, vendor, gummy, loc };
}

const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;

describe('list rate limit (token bucket)', () => {
  test('limited lists cost one per page and carry X-RateLimit-* headers; get-by-id / inventory / reports are free', async () => {
    const { get, clock } = setup();
    const r = await get('/purchases');
    expect(r.status).toBe(200);
    expect(r.headers.get('X-RateLimit-Limit')).toBe('3000');
    expect(r.headers.get('X-RateLimit-Remaining')).toBe('2999');
    expect(r.headers.get('X-RateLimit-Reset')).toBe('12'); // 1 call at 5/min
    const page2 = await get('/products?is_active=true');
    expect(page2.headers.get('X-RateLimit-Remaining')).toBe('2998');
    for (const path of ['/inventory?groupings[]=PRODUCT', '/reports/inventory-velocity', '/metrc/packages', `/products/${[...setup().mock.store.products.keys()][0]}`]) {
      const x = await get(path);
      expect(x.headers.get('X-RateLimit-Remaining')).toBeNull();
    }
    clock.advance(24_000); // 2 tokens back at 5/min
    expect((await get('/orders?ids[]=x')).headers.get('X-RateLimit-Remaining')).toBe('2999');
  });

  test('an updated_datetime lower bound within 30 days is free and never refused; others get 429 + Retry-After', async () => {
    const { get, config, clock } = setup();
    expect((await config({ rate_limit: { list: { tokens: 0 } } })).status).toBe(200);
    const recent = await get(`/purchases?updated_datetime=${iso(clock.now() - 29 * DAY)},`);
    expect(recent.status).toBe(200);
    expect(recent.headers.get('X-RateLimit-Remaining')).toBe('0');
    const old = await get(`/purchases?updated_datetime=${iso(clock.now() - 31 * DAY)},`);
    expect(old.status).toBe(429);
    expect(old.headers.get('Retry-After')).toBe('12');
    expect(old.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(((await old.json()) as Json).errors[0].message).toContain('List rate limit exceeded: 3000 calls per account, refilling at 5 per minute');
    expect((await get(`/purchases?updated_datetime=,${iso(clock.now())}`)).status).toBe(429); // upper bound only
    expect((await get('/tasks')).status).toBe(429);
    expect((await get('/users')).status).toBe(429);
    expect((await get('/activity')).status).toBe(200); // activity: free without changed_datetime
    expect((await get(`/activity?changed_datetime=${iso(clock.now() - 60 * DAY)},`)).status).toBe(429);
    clock.advance(12_000);
    expect((await get('/purchases')).status).toBe(200);
    expect((await get('/purchases')).status).toBe(429);
  });

  test('400s cost one too; legacy fail_next toggle still works; bucket can be disabled', async () => {
    const { get, config } = setup();
    expect((await get('/purchases?statuses[]=NOPE')).status).toBe(400);
    expect((await get('/purchases')).headers.get('X-RateLimit-Remaining')).toBe('2998');
    await config({ rate_limit: { fail_next: 1, retry_after: 3 } });
    const r = await get(`/purchases?updated_datetime=${iso(Date.parse(NOW))},`);
    expect(r.status).toBe(429);
    expect(r.headers.get('Retry-After')).toBe('3');
    await config({ rate_limit: { list: { enabled: false, tokens: 0 } } });
    expect((await get('/purchases')).status).toBe(200);
  });

  test('client findPurchaseByIdempotencyKey stays free (default lookback inside the window)', async () => {
    const { mock, post, poBody, get } = setup({ clock: () => Date.now() });
    const { createDistruClient, findPurchaseByIdempotencyKey, idempotencyMarker } = await import('@ops/distru-client');
    const created = (await (await post('/purchases', poBody({ description: `x\n${idempotencyMarker('k-free')}` }))).json()) as Json;
    const client = createDistruClient({ baseUrl: BASE, token: 'mock-token', fetch: (u, i) => Promise.resolve(mock.app.request(u, i)) });
    const before = Number((await get('/purchases')).headers.get('X-RateLimit-Remaining'));
    const found = await findPurchaseByIdempotencyKey(client, 'k-free');
    expect(found?.id).toBe(created.data.id);
    const after = Number((await get('/purchases')).headers.get('X-RateLimit-Remaining'));
    expect(before - after).toBe(1); // only the probe call itself cost one
  });
});

describe('purchase PDF', () => {
  test('binary / url / email formats; drafts are not found; 20/minute PDF limit', async () => {
    const { post, req, config, mock, poBody } = setup();
    const po = ((await (await post('/purchases', poBody())).json()) as Json).data;
    const bin = await post(`/purchases/${po.id}/pdf`, { format: 'binary' });
    expect(bin.headers.get('content-type')).toBe('application/pdf');
    expect(await bin.text()).toStartWith('%PDF-');
    const url = (await (await post(`/purchases/${po.id}/pdf`, { format: 'url' })).json()) as Json;
    expect(url.data.url).toContain(`/__mock/pdf/purchases/${po.id}.pdf`);
    expect(Date.parse(url.data.expires_datetime)).toBeGreaterThan(Date.parse(NOW));
    const email = (await (await post(`/purchases/${po.id}/pdf`, { format: 'email', email_addresses: ['a@vendor.example, b@vendor.example', 'a@vendor.example'] })).json()) as Json;
    expect(email.data.emailed_to).toEqual(['a@vendor.example', 'b@vendor.example']);
    expect(mock.store.outbox.at(-1)).toMatchObject({ source: 'PUBLIC_API', document: 'PURCHASE_ORDER', record_id: po.id });
    expect((await post(`/purchases/${po.id}/pdf`, { format: 'email', email_addresses: ['nope'] })).status).toBe(400);
    const draft = [...mock.store.purchases.values()].find((p) => p.status === 'DRAFT')!;
    expect((await post(`/purchases/${draft.id}/pdf`, { format: 'url' })).status).toBe(404);
    await config({ rate_limit: { pdf: { per_minute: 3 } } });
    const limited = await post(`/purchases/${po.id}/pdf`, { format: 'url' });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(((await limited.json()) as Json).errors[0].message).toContain('PDF download rate limit exceeded');
    void req;
  });
});

describe('tasks, users, custom fields, deleted records', () => {
  test('POST /tasks creates (201) and updates (200) sparsely; link is set-once; DELETE → 204 + tombstone', async () => {
    const { post, get, req, mock, poBody } = setup();
    const po = ((await (await post('/purchases', poBody())).json()) as Json).data;
    const sam = [...mock.store.users.values()].find((u) => u.full_name === 'Sam Rivera')!;
    const created = await post('/tasks', { name: 'Chase vendor', status: 'ACTIVE', due_datetime: '2026-11-25T17:00:00Z', owner_id: sam.id, purchase_id: po.id });
    expect(created.status).toBe(201);
    const task = ((await created.json()) as Json).data;
    expect(task).toMatchObject({ name: 'Chase vendor', status: 'ACTIVE', owner: { id: sam.id, full_name: 'Sam Rivera' }, purchase: { id: po.id }, creator: { full_name: 'Morgan Lee' } });
    expect(task.color).toMatch(/^[0-9A-F]{6}$/);
    const upd = await post('/tasks', { id: task.id, status: 'COMPLETED' });
    expect(upd.status).toBe(200);
    expect(((await upd.json()) as Json).data).toMatchObject({ status: 'COMPLETED', name: 'Chase vendor', purchase: { id: po.id } });
    const relink = await post('/tasks', { id: task.id, product_id: [...mock.store.products.keys()][0] });
    expect(relink.status).toBe(400);
    expect(((await relink.json()) as Json).errors[0].pointer).toEqual(['product_id']);
    const two = await post('/tasks', { name: 'x', status: 'ACTIVE', due_datetime: '2026-11-25T17:00:00Z', purchase_id: po.id, product_id: [...mock.store.products.keys()][0] });
    expect(two.status).toBe(400);
    const missing = ((await (await post('/tasks', {})).json()) as Json).errors.map((e: Json) => e.pointer[0]).sort();
    expect(missing).toEqual(['due_datetime', 'name', 'status']);
    const list = ((await (await get(`/tasks?statuses[]=COMPLETED&related_types[]=PURCHASE`)).json()) as Json).data;
    expect(list.map((t: Json) => t.id)).toContain(task.id);
    expect((await req(`/public/v1/tasks/${task.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await get(`/tasks/${task.id}`)).status).toBe(404);
    const tomb = ((await (await get('/deleted-records?record_type=TASK')).json()) as Json).data;
    expect(tomb).toEqual([{ record_type: 'TASK', record_id: task.id, deleted_datetime: expect.any(String) }]);
    expect((await get('/deleted-records')).status).toBe(400);
  });

  test('users list + get', async () => {
    const { get, mock } = setup();
    const users = ((await (await get('/users')).json()) as Json).data;
    expect(users.map((u: Json) => u.full_name)).toEqual(['Jordan Kim', 'Morgan Lee', 'Sam Rivera', 'Taylor Brooks']);
    const one = ((await (await get(`/users/${mock.store.apiUserId}`)).json()) as Json).data;
    expect(one).toMatchObject({ full_name: 'Morgan Lee', role: { name: 'Admin' } });
  });

  test('custom fields: list/create; custom_data on purchase upsert is validated, returned and filterable', async () => {
    const { get, post, poBody } = setup();
    const defs = ((await (await get('/custom-fields?parent_object=purchase')).json()) as Json).data;
    expect(defs.map((d: Json) => d.name)).toEqual(['External reference', 'Buyer']);
    const created = await post('/custom-fields', { name: 'Ops Agent idempotency key', parent_object: 'purchase', field_type: 'text' });
    expect(created.status).toBe(201);
    const idemField = ((await created.json()) as Json).data;
    expect(idemField).toMatchObject({ field_type: 'text', filterable: false, required: false });
    expect((await post('/custom-fields', { name: 'X', parent_object: 'purchase', field_type: 'text', filterable: true })).status).toBe(400);
    const buyer = defs.find((d: Json) => d.name === 'Buyer');
    const po = ((await (await post('/purchases', poBody({ custom_data: { [idemField.id]: 'run-1:op-0', [buyer.id]: 'Edibles team' } }))).json()) as Json).data;
    expect(po.custom_data).toEqual(
      expect.arrayContaining([
        { id: idemField.id, name: 'Ops Agent idempotency key', value: 'run-1:op-0' },
        { id: buyer.id, name: 'Buyer', value: 'Edibles team' },
        expect.objectContaining({ name: 'External reference', value: null }),
      ]),
    );
    const bad = await post('/purchases', poBody({ custom_data: { [buyer.id]: 'Nobody', 999: 'x' } }));
    expect(((await bad.json()) as Json).errors.map((e: Json) => e.pointer.join('.')).sort()).toEqual([`custom_data.${buyer.id}`, 'custom_data.999']);
    const filtered = ((await (await get(`/purchases?custom_data[${buyer.id}]=Edibles%20team`)).json()) as Json).data;
    expect(filtered.map((p: Json) => p.id)).toEqual([po.id]);
    expect((await get(`/purchases?custom_data[${idemField.id}]=run-1:op-0`)).status).toBe(400); // text fields aren't filterable
    const cleared = ((await (await post('/purchases', { id: po.id, custom_data: { [buyer.id]: null } })).json()) as Json).data;
    expect(cleared.custom_data.find((c: Json) => c.id === buyer.id).value).toBeNull();
    expect(cleared.custom_data.find((c: Json) => c.id === idemField.id).value).toBe('run-1:op-0');
  });

  test('client idempotency lookup prefers the custom field', async () => {
    const { mock, post, poBody } = setup({ clock: () => Date.now() });
    const { createDistruClient, findPurchaseByIdempotencyKey, buildPurchaseOrder, upsertPurchaseVerified } = await import('@ops/distru-client');
    const client = createDistruClient({ baseUrl: BASE, token: 'mock-token', fetch: (u, i) => Promise.resolve(mock.app.request(u, i)) });
    const field = ((await (await post('/custom-fields', { name: 'Idempotency key', parent_object: 'purchase', field_type: 'text' })).json()) as Json).data;
    const b = poBody();
    const body = buildPurchaseOrder({ vendorId: b.company_id, locationId: b.location_id, lines: [{ productId: b.items[0]!.product_id, quantity: 12, unitPrice: 7 }], idempotencyKey: 'run-7:op-0', idempotencyCustomFieldId: field.id });
    const res = await upsertPurchaseVerified(client, body);
    expect(res.mismatches).toEqual([]);
    // a human edits the description (marker gone): the custom field still finds it
    await post('/purchases', { id: res.purchase.id, description: 'edited' });
    expect((await findPurchaseByIdempotencyKey(client, 'run-7:op-0'))?.id).toBeUndefined();
    expect((await findPurchaseByIdempotencyKey(client, 'run-7:op-0', { idempotencyCustomFieldId: field.id }))?.id).toBe(res.purchase.id);
  });
});

describe('activity + record history', () => {
  test('REST writes show with source PUBLIC_API; defaults to the last 7 days; record-history 404 for unknown records', async () => {
    const { get, post, poBody } = setup({ clock: () => Date.now() });
    const po = ((await (await post('/purchases', poBody())).json()) as Json).data;
    await post('/purchases', { id: po.id, status: 'PROCESSING', items: [{ id: po.items[0].id, quantity: 48 }] });
    const act = ((await (await get('/activity')).json()) as Json).data;
    expect(act).toHaveLength(2);
    expect(act[0]).toMatchObject({ source: 'PUBLIC_API', actor: { name: 'Morgan Lee' }, record_counts: [{ type: 'PURCHASE', count: 1 }] });
    expect(act[0].records[0].rows.map((r: Json) => r.entity)).toEqual(['PURCHASE', 'PURCHASE_ITEM']);
    const hist = ((await (await get(`/record-history?record_type=PURCHASE&record_id=${po.id}`)).json()) as Json).data;
    expect(hist).toHaveLength(2);
    expect(hist[0].rows[1]).toMatchObject({ entity: 'PURCHASE_ITEM', op: 'UPDATE', fields: [{ field: 'quantity', old_value: '24', new_value: '48', label: 'Quantity' }] });
    expect(((await (await get(`/activity?ids[]=${act[1].id}`)).json()) as Json).data).toHaveLength(1);
    expect((await get('/record-history?record_type=PURCHASE&record_id=nope')).status).toBe(404);
    const seeded = ((await (await get(`/record-history?record_type=PURCHASE&record_id=${[...setup().mock.store.purchases.keys()][0]}`)).json()) as Json).data;
    expect(Array.isArray(seeded)).toBe(true);
  });
});

describe('webhooks', () => {
  test('per-record ordering with retries; object fetched at send time; PRODUCT + PACKAGE events', async () => {
    const delivered: Json[] = [];
    let failFirst = 1;
    const { post, mock, poBody, gummy, loc, vendor } = setup({
      webhookUrl: 'http://hooks.test/distru',
      webhookRetryDelaysMs: [5, 5],
      webhookFetch: async (_url, init) => {
        const body = JSON.parse(String(init.body)) as Json;
        if (body.type === 'PURCHASE' && failFirst-- > 0) return new Response('busy', { status: 503 });
        delivered.push(body);
        return new Response('ok');
      },
    });
    const po = ((await (await post('/purchases', poBody())).json()) as Json).data;
    await post('/purchases', { id: po.id, status: 'PROCESSING' });
    await post('/purchases', { id: po.id, description: 'third' });
    await mock.webhooks.idle();
    const purchaseHooks = delivered.filter((h) => h.type === 'PURCHASE');
    expect(purchaseHooks.map((h) => h.event)).toEqual(['CREATE', 'UPDATE', 'UPDATE']);
    expect(purchaseHooks.map((h) => h.occurred_datetime)).toEqual([...purchaseHooks.map((h) => h.occurred_datetime)].sort());
    expect(purchaseHooks[1]!.changes.status).toEqual({ before: 'PENDING', after: 'PROCESSING' });
    // the CREATE was retried after the later edits: its object is the record as it is at send time
    expect(purchaseHooks[0]!.object.description).toBe('third');
    expect(purchaseHooks[0]!.changes).toEqual({});
    expect(mock.store.webhookLog.find((w) => w.type === 'PURCHASE')!.attempts).toBe(2);

    // receiving product-tracked stock fires a PRODUCT webhook with company-wide quantities
    const battery = [...mock.store.products.values()].find((p) => p.sku === 'ACC-BAT-BLK')!;
    await post('/purchases', poBody({ status: 'COMPLETED', items: [{ product_id: battery.id, location_id: loc, quantity: 50, price: 4 }] }));
    await mock.webhooks.idle();
    const productHook = delivered.find((h) => h.type === 'PRODUCT' && h.id === battery.id)!;
    expect(productHook.event).toBe('UPDATE');
    expect(Number(productHook.changes.quantity_active.after) - Number(productHook.changes.quantity_active.before)).toBe(50);
    expect(productHook.changes.quantity_available).toBeDefined();
    expect(productHook.object.id).toBe(battery.id);

    // a package adjustment (via ops, as MCP does) fires PACKAGE + PRODUCT
    const lot = [...mock.store.lots.values()].find((l) => l.compliance_label && l.quantity > 3 && !l.on_hold)!;
    const res = mock.ops.adjustInventory({ packageId: lot.id, quantity: -1, complianceReason: 'Damage', description: 'test' }, 'MCP');
    expect(res.ok).toBe(true);
    await mock.webhooks.idle();
    const pkgHook = delivered.find((h) => h.type === 'PACKAGE' && h.id === lot.id)!;
    expect(pkgHook.changes.quantity_active).toEqual({ before: String(lot.quantity + 1), after: String(lot.quantity) });
    expect(pkgHook.object.compliance_label).toBe(lot.compliance_label);
    void gummy;
    void vendor;
  });

  test('DELETE webhook has a null object', async () => {
    const delivered: Json[] = [];
    const { post, mock, poBody } = setup({ webhookUrl: 'http://hooks.test/x', webhookRetryDelaysMs: [], webhookFetch: async (_u, init) => (delivered.push(JSON.parse(String(init.body))), new Response('ok')) });
    const po = ((await (await post('/purchases', poBody())).json()) as Json).data;
    expect(mock.ops.deletePurchase(po.id, 'MCP').ok).toBe(true);
    await mock.webhooks.idle();
    expect(delivered.at(-1)).toMatchObject({ type: 'PURCHASE', event: 'DELETE', id: po.id, object: null, changes: {} });
  });
});
