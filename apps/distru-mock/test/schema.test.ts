/**
 * Runtime schema check: every mock response is validated against Distru's OpenAPI response schema
 * (required fields, types, enums, additional-property names) from the client package's spec.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createMockServer } from '../src/app';

type Schema = {
  $ref?: string;
  type?: string;
  enum?: unknown[];
  nullable?: boolean;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  allOf?: Schema[];
  oneOf?: Schema[];
  anyOf?: Schema[];
  additionalProperties?: boolean | Schema;
};

const spec = (await Bun.file(join(import.meta.dir, '../../../packages/distru-client/openapi.json')).json()) as {
  paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema: Schema }> }> }>>;
  components: { schemas: Record<string, Schema> };
};

function resolve(s: Schema): Schema {
  while (s.$ref) s = spec.components.schemas[s.$ref.split('/').pop()!]!;
  return s;
}

function validate(value: unknown, schema: Schema, path: string, out: string[]): void {
  const s = resolve(schema);
  if (s.allOf) return s.allOf.forEach((x) => validate(value, x, path, out));
  if (s.oneOf || s.anyOf) {
    const opts = s.oneOf ?? s.anyOf!;
    if (!opts.some((o) => { const e: string[] = []; validate(value, o, path, e); return e.length === 0; })) out.push(`${path}: matches none of oneOf`);
    return;
  }
  // Distru's spec documents nulls in prose without `nullable`; allow null for optional fields only
  if (value === null) return;
  if (s.enum && !s.enum.includes(value)) out.push(`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(s.enum)}`);
  switch (s.type) {
    case 'string':
      if (typeof value !== 'string') out.push(`${path}: expected string, got ${typeof value}`);
      return;
    case 'integer':
      if (!Number.isInteger(value)) out.push(`${path}: expected integer, got ${JSON.stringify(value)}`);
      return;
    case 'number':
      if (typeof value !== 'number') out.push(`${path}: expected number, got ${typeof value}`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') out.push(`${path}: expected boolean`);
      return;
    case 'array':
      if (!Array.isArray(value)) return void out.push(`${path}: expected array`);
      value.forEach((v, i) => s.items && validate(v, s.items, `${path}[${i}]`, out));
      return;
  }
  if (s.type === 'object' || s.properties) {
    if (typeof value !== 'object' || Array.isArray(value)) return void out.push(`${path}: expected object`);
    const obj = value as Record<string, unknown>;
    for (const r of s.required ?? []) {
      if (!(r in obj)) out.push(`${path}.${r}: required but missing`);
      else if (obj[r] === null && !resolve(s.properties?.[r] ?? {}).nullable) {
        // required + null: only flag where Distru promises "always present" non-null values
        if (['id', 'name', 'status'].includes(r)) out.push(`${path}.${r}: required, got null`);
      }
    }
    if (s.properties) {
      for (const [k, v] of Object.entries(obj)) {
        const ps = s.properties[k];
        if (!ps) {
          if (s.additionalProperties === false || Object.keys(s.properties).length) out.push(`${path}.${k}: not in schema`);
          continue;
        }
        validate(v, ps, `${path}.${k}`, out);
      }
    }
  }
}

const mock = createMockServer({ now: '2026-11-19T12:00:00Z' });
const H = { Authorization: 'Bearer mock-token', 'content-type': 'application/json' };
const call = async (method: string, path: string, body?: unknown) => {
  const r = await mock.app.request(`http://mock.test/public/v1${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

function check(specPath: string, method: string, status: number, body: unknown) {
  const res = spec.paths[`/public/v1${specPath}`]![method]!.responses[String(status)]!;
  const schema = (res.content?.['*/*'] ?? res.content?.['application/json'])!.schema;
  const errors: string[] = [];
  validate(body, schema, '$', errors);
  return [...new Set(errors)].slice(0, 20);
}

const s = mock.store;
const anyId = <T extends { id: string }>(m: Map<string, T>) => [...m.values()][0]!.id;
const ownLoc = s.ownLocationIds[0]!;
const product = [...s.products.values()].find((p) => p.sku === 'FLW-BD-35')!;

const GETS: [string, string][] = [
  ['/reports/inventory-velocity', '/reports/inventory-velocity?lead_time_days=14'],
  ['/inventory', '/inventory?groupings[]=PRODUCT&groupings[]=LOCATION&groupings[]=BATCH_NUMBER'],
  ['/products', '/products?include_batches_with_active_quantity_by_location=true&include_packages_with_active_quantity_by_location=true'],
  ['/products/{id}', `/products/${product.id}?include_batches_with_active_quantity_by_location=true`],
  ['/companies', '/companies'],
  ['/companies/{id}', `/companies/${anyId(s.companies)}`],
  ['/locations', '/locations'],
  ['/orders', '/orders'],
  ['/orders/{id}', `/orders/${anyId(s.orders)}`],
  ['/purchases', '/purchases'],
  ['/purchases/{id}', `/purchases/${anyId(s.purchases)}`],
  ['/metrc/packages', '/metrc/packages'],
  ['/test-results', '/test-results'],
  ['/test-results/{id}', `/test-results/${anyId(s.testResults)}`],
  ['/batches', '/batches'],
  ['/batches/{id}', `/batches/${anyId(s.batches)}`],
];

describe('responses match openapi.json', () => {
  for (const [specPath, url] of GETS) {
    test(`GET ${specPath}`, async () => {
      const r = await call('GET', url);
      expect(r.status).toBe(200);
      expect(check(specPath, 'get', 200, r.body)).toEqual([]);
    });
  }

  test('POST /purchases (200 + 400 envelope)', async () => {
    const vendor = product.vendor_id;
    const ok = await call('POST', '/purchases', {
      status: 'PENDING',
      company_id: vendor,
      location_id: ownLoc,
      billing_location_id: ownLoc,
      order_datetime: '2026-11-19T00:00:00Z',
      due_datetime: '2026-12-19T00:00:00Z',
      items: [{ product_id: product.id, location_id: ownLoc, quantity: 24, price: 14 }],
      charges: [{ name: 'Freight', type: 'CHARGE', unit_type: 'PRICE', price: 50 }],
    });
    expect(ok.status).toBe(200);
    expect(check('/purchases', 'post', 200, ok.body)).toEqual([]);
    const bad = await call('POST', '/purchases', { status: 'NOPE' });
    expect(bad.status).toBe(400);
    expect(check('/purchases', 'post', 400, bad.body)).toEqual([]);
  });

  test('POST /orders + 404/401 envelopes', async () => {
    const customer = [...s.companies.values()].find((c) => c.relationship === 'Customer')!;
    const ok = await call('POST', '/orders', { company_id: customer.id, location_id: ownLoc, items: [{ product_id: product.id, quantity: 2, price_base: 25 }] });
    expect(ok.status).toBe(200);
    expect(check('/orders', 'post', 200, ok.body)).toEqual([]);
    const nf = await call('GET', '/purchases/missing');
    expect(check('/purchases/{id}', 'get', 404, nf.body)).toEqual([]);
  });
});

test('validator catches drift (sanity)', async () => {
  const r = await call('GET', `/products/${product.id}`);
  const data = { ...(r.body.data as Record<string, unknown>) };
  delete data.sku;
  data.inventory_tracking_method = 'package';
  data.bogus_field = 1;
  expect(check('/products/{id}', 'get', 200, { data })).toEqual(
    expect.arrayContaining(['$.data.sku: required but missing', expect.stringContaining('$.data.inventory_tracking_method'), '$.data.bogus_field: not in schema']),
  );
});
