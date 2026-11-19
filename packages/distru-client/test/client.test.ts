import { describe, expect, test } from 'bun:test';
import {
  bracketArrayParams,
  buildPurchaseOrder,
  createDistruClient,
  DistruApiError,
  extractIdempotencyKey,
  operations,
  parseRetryAfter,
  verifyPurchase,
  type DistruClientConfig,
  type Purchase,
} from '../src';

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body?: string;
}

/** Stub fetch that replays queued responses and records calls. */
function stubFetch(responses: (Response | ((call: Call) => Response))[]) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request ${url}`);
    return typeof next === 'function' ? next(call) : next;
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function client(responses: Parameters<typeof stubFetch>[0], extra: Partial<DistruClientConfig> = {}) {
  const stub = stubFetch(responses);
  const sleeps: number[] = [];
  const c = createDistruClient({
    baseUrl: 'http://distru.test',
    token: 'tok',
    fetch: stub.fetch,
    sleep: async (ms) => void sleeps.push(ms),
    ...extra,
  });
  return { c, calls: stub.calls, sleeps };
}

describe('request basics', () => {
  test('sends auth/accept headers and serialises array params with brackets', async () => {
    const { c, calls } = client([json({ data: { meta: {}, data: [] } })]);
    await c.getInventoryVelocityReport({ below_reorder_point: true, lead_time_days: 14, vendor_ids: ['v1', 'v2'] });
    const call = calls[0]!;
    expect(call.url).toBe(
      'http://distru.test/public/v1/reports/inventory-velocity?below_reorder_point=true&lead_time_days=14&vendor_ids[]=v1&vendor_ids[]=v2',
    );
    expect(call.headers.get('authorization')).toBe('Bearer tok');
    expect(call.headers.get('accept')).toBe('application/json');
  });

  test('POST sends JSON body with content-type', async () => {
    const { c, calls } = client([json({ data: { id: 'p1' } })]);
    const res = await c.upsertPurchase({ status: 'DRAFT' });
    expect(res.data?.id).toBe('p1');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ status: 'DRAFT' });
  });

  test('path params and trailing /public/v1 on baseUrl', async () => {
    const { c, calls } = client([json({ data: { id: 'x' } })], { baseUrl: 'https://app.distru.com/public/v1/' });
    await c.getProduct('abc', { include_batches_with_active_quantity_by_location: true });
    expect(calls[0]!.url).toBe(
      'https://app.distru.com/public/v1/products/abc?include_batches_with_active_quantity_by_location=true',
    );
  });

  test('two clients do not share config', async () => {
    const a = client([json({ data: [] })], { token: 'A' });
    const b = client([json({ data: [] })], { token: 'B' });
    await Promise.all([a.c.listCompanies(), b.c.listCompanies()]);
    expect(a.calls[0]!.headers.get('authorization')).toBe('Bearer A');
    expect(b.calls[0]!.headers.get('authorization')).toBe('Bearer B');
  });

  test('every generated operation is bound (options is always the last param)', () => {
    const { c } = client([]);
    const names = Object.keys(operations).filter((k) => !/^get.+Url$/.test(k));
    expect(names.length).toBeGreaterThan(10);
    for (const n of names) expect(typeof (c as unknown as Record<string, unknown>)[n]).toBe('function');
  });

  test('unbound operation without config fails loudly', async () => {
    await expect(operations.listProducts()).rejects.toThrow(/not configured/);
  });

  test('bracketArrayParams leaves absolute URLs untouched', () => {
    expect(bracketArrayParams('http://x/public/v1/products?ids=a')).toBe('http://x/public/v1/products?ids=a');
    expect(bracketArrayParams('/public/v1/products?ids=a&name=b')).toBe('/public/v1/products?ids[]=a&name=b');
  });
});

describe('error envelope', () => {
  test('400 → DistruApiError with typed errors and pointers', async () => {
    const { c } = client([
      json(
        {
          errors: [
            { message: 'must be greater than 0', pointer: ['items', 0, 'quantity'] },
            { message: 'is required', pointer: ['company_id'] },
          ],
        },
        400,
      ),
    ]);
    const err = await c.upsertPurchase({ status: 'PENDING' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DistruApiError);
    const e = err as DistruApiError;
    expect(e.status).toBe(400);
    expect(e.isValidationError).toBe(true);
    expect(e.errors).toHaveLength(2);
    expect(e.errorsAt('items', 0)).toEqual([{ message: 'must be greater than 0', pointer: ['items', 0, 'quantity'] }]);
    expect(e.message).toContain('must be greater than 0 (at items.0.quantity)');
    expect(e.method).toBe('POST');
  });

  test('404 and 401 flags', async () => {
    const { c } = client([
      json({ errors: [{ message: 'Not found', pointer: ['base'] }] }, 404),
      json({ errors: [{ message: 'Invalid token', pointer: ['base'] }] }, 401),
    ]);
    const nf = (await c.getPurchase('nope').catch((e: unknown) => e)) as DistruApiError;
    expect(nf.isNotFound).toBe(true);
    expect(nf.message).toBe('Distru GET /public/v1/purchases/nope failed with 404: Not found');
    const au = (await c.listProducts().catch((e: unknown) => e)) as DistruApiError;
    expect(au.isAuthError).toBe(true);
  });

  test('non-envelope error body is preserved', async () => {
    const { c } = client([new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' })]);
    const e = (await c.listProducts().catch((x: unknown) => x)) as DistruApiError;
    expect(e.status).toBe(502);
    expect(e.errors[0]!.pointer).toEqual(['base']);
    expect(e.body).toBe('<html>bad gateway</html>');
  });
});

describe('429 handling', () => {
  test('honours Retry-After then succeeds', async () => {
    const limited = () => json({ errors: [{ message: 'rate limited', pointer: ['base'] }] }, 429, { 'Retry-After': '2' });
    const { c, calls, sleeps } = client([limited(), limited(), json({ data: [{ id: 'p' }], next_page: null })]);
    const res = await c.listProducts();
    expect(res.data?.[0]?.id).toBe('p');
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([2000, 2000]);
  });

  test('gives up after maxRetries with retryAfterSeconds', async () => {
    const limited = () => json({ errors: [{ message: 'rate limited', pointer: ['base'] }] }, 429, { 'Retry-After': '1' });
    const { c, calls, sleeps } = client([limited(), limited(), limited()], { maxRetries: 2 });
    const e = (await c.listProducts().catch((x: unknown) => x)) as DistruApiError;
    expect(e.isRateLimited).toBe(true);
    expect(e.retryAfterSeconds).toBe(1);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 1000]);
  });

  test('does not wait longer than maxRetryDelayMs', async () => {
    const { c, sleeps } = client([json({ errors: [{ message: 'slow down', pointer: ['base'] }] }, 429, { 'Retry-After': '600' })], {
      maxRetryDelayMs: 5000,
    });
    const e = (await c.listProducts().catch((x: unknown) => x)) as DistruApiError;
    expect(e.status).toBe(429);
    expect(e.retryAfterSeconds).toBe(600);
    expect(sleeps).toEqual([]);
  });

  test('missing Retry-After uses default delay', async () => {
    const { c, sleeps } = client([new Response('', { status: 429 }), json({ data: [] })], { defaultRetryDelayMs: 250 });
    await c.listProducts();
    expect(sleeps).toEqual([250]);
  });

  test('parseRetryAfter handles seconds and HTTP dates', () => {
    expect(parseRetryAfter('42')).toBe(42);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('garbage')).toBeUndefined();
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:10 GMT', now)).toBe(10);
  });
});

describe('pagination', () => {
  test('follows next_page exactly until null', async () => {
    const p2 = 'http://distru.test/public/v1/products?is_active=true&page[after]=c2';
    const p3 = 'http://distru.test/public/v1/products?is_active=true&page[after]=c3';
    const { c, calls } = client([
      json({ data: [{ id: '1' }, { id: '2' }], next_page: p2 }),
      json({ data: [{ id: '3' }], next_page: p3 }),
      json({ data: [{ id: '4' }], next_page: null }),
    ]);
    const ids: string[] = [];
    for await (const p of c.paginate(c.listProducts, { is_active: true })) ids.push(p.id);
    expect(ids).toEqual(['1', '2', '3', '4']);
    expect(calls.map((x) => x.url)).toEqual(['http://distru.test/public/v1/products?is_active=true', p2, p3]);
    expect(calls.every((x) => x.headers.get('authorization') === 'Bearer tok')).toBe(true);
  });

  test('limit stops early without fetching more pages', async () => {
    const { c, calls } = client([
      json({ data: [{ id: '1' }, { id: '2' }], next_page: 'http://distru.test/public/v1/companies?page[after]=x' }),
    ]);
    const all = await c.listAll(c.listCompanies, undefined, { limit: 2 });
    expect(all.map((x) => x.id)).toEqual(['1', '2']);
    expect(calls).toHaveLength(1);
  });

  test('pages() yields page objects and works with an unbound operation', async () => {
    const { c } = client([json({ data: [{ id: 'a' }], next_page: null })]);
    const pages = [];
    for await (const page of c.pages(operations.listBatches, { has_quantity_active: true })) pages.push(page);
    expect(pages).toHaveLength(1);
  });

  test('refuses to follow next_page to a foreign origin (token safety)', async () => {
    const { c } = client([json({ data: [{ id: '1' }], next_page: 'https://evil.example/steal' })]);
    await expect(c.listAll(c.listProducts, {})).rejects.toThrow(/Refusing/);
  });

  test('429 mid-pagination is retried', async () => {
    const next = 'http://distru.test/public/v1/orders?page[after]=z';
    const { c, sleeps } = client([
      json({ data: [{ id: 'o1' }], next_page: next }),
      json({ errors: [{ message: 'rl', pointer: ['base'] }] }, 429, { 'Retry-After': '0' }),
      json({ data: [{ id: 'o2' }], next_page: null }),
    ]);
    const all = await c.listAll(c.listOrders, { statuses: ['PENDING'] });
    expect(all.map((o) => o.id)).toEqual(['o1', 'o2']);
    expect(sleeps).toEqual([0]);
  });

  test('maxPages guards runaway pagination', async () => {
    const loop = 'http://distru.test/public/v1/products?page[after]=same';
    const { c } = client([json({ data: [], next_page: loop }), json({ data: [], next_page: loop })]);
    await expect(c.listAll(c.listProducts, {}, { maxPages: 2 })).rejects.toThrow(/maxPages/);
  });
});

describe('purchase helpers', () => {
  test('buildPurchaseOrder copies location onto lines and stamps idempotency key', () => {
    const body = buildPurchaseOrder({
      vendorId: 'v1',
      locationId: 'loc1',
      lines: [{ productId: 'p1', quantity: 10, unitPrice: 4.5 }, { batchId: 'b1', quantity: 2, unitPrice: 1 }],
      orderDatetime: '2026-01-01T00:00:00Z',
      paymentTermDays: 15,
      description: 'Restock',
      idempotencyKey: 'run-1:op-0',
    });
    expect(body).toMatchObject({
      status: 'PENDING',
      company_id: 'v1',
      location_id: 'loc1',
      billing_location_id: 'loc1',
      order_datetime: '2026-01-01T00:00:00Z',
      due_datetime: '2026-01-16T00:00:00Z',
      items: [
        { product_id: 'p1', location_id: 'loc1', quantity: 10, price: 4.5 },
        { batch_id: 'b1', location_id: 'loc1', quantity: 2, price: 1 },
      ],
    });
    expect(extractIdempotencyKey(body.description)).toBe('run-1:op-0');
  });

  test('verifyPurchase reports mismatches', () => {
    const sent = buildPurchaseOrder({
      vendorId: 'v1',
      locationId: 'loc1',
      lines: [{ productId: 'p1', quantity: 10, unitPrice: 4.5 }],
    });
    const stored = {
      id: 'po1',
      status: 'PENDING',
      company: { id: 'v1', name: 'V', tasks: [], updated_datetime: '' },
      location: { id: 'loc1', name: 'L', address: '' },
      billing_location: { id: 'loc1', name: 'L', address: '' },
      items: [{ id: 'i1', product: { id: 'p1' }, quantity: '12.000', price: '4.50', price_base: '4.50', is_sample: false }],
    } as unknown as Purchase;
    expect(verifyPurchase(sent, stored)).toEqual([{ field: 'items.0.quantity', expected: 10, actual: 12 }]);
  });
});
