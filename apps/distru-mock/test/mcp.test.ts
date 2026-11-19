/**
 * Distru MCP mock, driven with the official MCP SDK client over Streamable HTTP (in-process fetch into
 * the Hono app; one test over a real bun server on a random port).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMockServer, type MockServer } from '../src/app';
import { TOOL_DEFS } from '../src/mcp/schemas.gen';

const NOW = '2026-11-19T12:00:00Z';
const KEY = 'distru_mcp_test';
const BASE = 'http://mock.test';
const COMMON = { intent: 'Restock low inventory for the Oakland warehouse', userSatisfactionEstimate: 5 };

let mock: MockServer;
let clients: Client[] = [];

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function connect(headers: Record<string, string> = {}, m: MockServer = mock) {
  const client = new Client({ name: 'mcp-mock-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    fetch: (url, init) => Promise.resolve(m.app.request(String(url), init)),
    requestInit: { headers: { Authorization: `Bearer ${KEY}`, ...headers } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Json = {}, common: Json | null = COMMON) {
  const res = (await client.callTool({ name, arguments: { ...(common ?? {}), ...args } })) as { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Json };
  const body = JSON.parse(res.content[0]!.text) as Json;
  return { isError: !!res.isError, body };
}

async function ok(client: Client, name: string, args: Json = {}) {
  const r = await call(client, name, args);
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.body)}`);
  return r.body;
}

/** Raw JSON-RPC POST (no SDK), to look at HTTP status and headers. */
const raw = (body: unknown, headers: Record<string, string> = { Authorization: `Bearer ${KEY}` }) =>
  mock.app.request(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
const rawCall = (name: string, args: Json = {}, id = 1) => raw({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { ...COMMON, ...args } } });

const rest = async (path: string, init: RequestInit = {}) => {
  const r = await mock.app.request(`${BASE}/public/v1${path}`, { ...init, headers: { Authorization: 'Bearer mock-token', 'content-type': 'application/json', ...(init.headers ?? {}) } });
  return { status: r.status, body: (r.status === 204 ? null : await r.json()) as Json };
};
const config = (body: unknown) => mock.app.request(`${BASE}/__mock/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const state = async () => (await (await mock.app.request(`${BASE}/__mock/state`)).json()) as Json;

function fixtures() {
  const s = mock.store;
  const vendor = [...s.companies.values()].find((c) => c.name === 'Golden State Edibles')!;
  const gummy = [...s.products.values()].find((p) => p.sku === 'EDB-GUM-WM')!;
  const gummy2 = [...s.products.values()].find((p) => p.sku === 'EDB-GUM-SB')!;
  return { vendor, gummy, gummy2, loc: s.ownLocationIds[0]! };
}

async function createPo(client: Client, extra: Json = {}) {
  const { vendor, gummy, loc } = fixtures();
  return ok(client, 'distru-mutate-purchase-order', {
    action: 'CREATE',
    supplierId: `com_${vendor.id}`,
    intakeLocationId: `loc_${loc}`,
    dueDatetime: '2026-12-19T00:00:00-08:00',
    description: 'Restock via MCP',
    orderItems: [{ productId: `prd_${gummy.id}`, quantity: 96, price: '7' }],
    ...extra,
  });
}

beforeEach(() => {
  mock = createMockServer({ now: NOW });
});
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  clients = [];
});

describe('transport + auth', () => {
  test('401 without a distru_mcp_ bearer key', async () => {
    const init = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '0' } } };
    const none = await raw(init, {});
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toContain('Bearer');
    expect((await raw(init, { Authorization: 'Bearer mock-token' })).status).toBe(401);
    expect((await raw(init, { Authorization: `Bearer ${KEY}` })).status).toBe(200);
    const bad = new Client({ name: 't', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { fetch: (u, i) => Promise.resolve(mock.app.request(String(u), i)), requestInit: { headers: { Authorization: 'Bearer nope' } } });
    await expect(bad.connect(transport)).rejects.toThrow();
  });

  test('configured key is required exactly', async () => {
    mock = createMockServer({ now: NOW, mcpKey: 'distru_mcp_only_this' });
    const init = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '0' } } };
    expect((await raw(init)).status).toBe(401);
    expect((await raw(init, { Authorization: 'Bearer distru_mcp_only_this' })).status).toBe(200);
  });

  test('works over a real HTTP server', async () => {
    const server = Bun.serve({ port: 0, fetch: mock.app.fetch });
    try {
      const client = new Client({ name: 't', version: '0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${server.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } }));
      clients.push(client);
      const me = await ok(client, 'distru-get-me');
      expect(me.myCompany.name).toBe('Golden Coast Distribution');
      expect(me.timezone).toBe('America/Los_Angeles');
      expect(me.user.id).toStartWith('usr_');
    } finally {
      server.stop(true);
    }
  });
});

describe('tools/list', () => {
  test('Distru names, model-facing descriptions from the docs, common inputs required', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(TOOL_DEFS).sort());
    for (const t of tools) {
      const def = TOOL_DEFS[t.name as keyof typeof TOOL_DEFS];
      expect(t.description).toBe(def.description);
      expect(t.inputSchema.required).toEqual(expect.arrayContaining(['intent', 'userSatisfactionEstimate']));
    }
    const mpo = tools.find((t) => t.name === 'distru-mutate-purchase-order')!;
    expect(mpo.description).toStartWith('Creates, updates or deletes one purchase order');
    expect((mpo.inputSchema.required as string[]).includes('action')).toBe(true);
  });

  test('write tools carry kind + external systems in _meta and MCP annotations', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const meta = (n: string) => tools.find((t) => t.name === n)!;
    expect(meta('distru-mutate-purchase-order')._meta).toMatchObject({ distru: { kind: 'write', reaches: ['quickbooks'], irreversible: ['DELETE'] } });
    expect(meta('distru-adjust-inventory')._meta).toMatchObject({ distru: { kind: 'write', reaches: ['biotrack', 'metrc'], irreversible: true } });
    expect(meta('distru-email-pdf')._meta).toMatchObject({ distru: { kind: 'write', reaches: ['email'] } });
    expect(meta('distru-mutate-task')._meta).toMatchObject({ distru: { kind: 'write', reaches: [] } });
    expect(meta('distru-mutate-purchase-order').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    expect(meta('distru-email-pdf').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    expect(meta('distru-search-products').annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(meta('distru-search-products')._meta).toMatchObject({ distru: { kind: 'read', reaches: [] } });
  });

  test('x-distru-filter-tool-tags: read hides write tools', async () => {
    const client = await connect({ 'x-distru-filter-tool-tags': 'read' });
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(10);
    expect(tools.every((t) => (t._meta as Json).distru.kind === 'read')).toBe(true);
    expect(tools.some((t) => t.name === 'distru-mutate-purchase-order')).toBe(false);
    const r = await call(client, 'distru-mutate-task', { action: 'CREATE', name: 'x', dueDate: '2026-12-01T00:00:00-08:00' });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.body)).toContain('unknown tool');
    expect(mock.store.tasks.size).toBe(4);
  });
});

describe('conventions', () => {
  test('search paging: limit default 10, cursor, totalCount, prefixed ids; cursor bound to its arguments', async () => {
    const client = await connect();
    const first = await ok(client, 'distru-search-products', { sortBy: { field: 'NAME', direction: 'ASC' } });
    expect(first.items).toHaveLength(10);
    expect(first.hasMore).toBe(true);
    expect(first.totalCount).toBe(42);
    expect(first.items[0].id).toMatch(/^prd_[0-9a-f-]{36}$/);
    expect(first.items[0].vendor.id).toStartWith('com_');
    const seen = new Set<string>(first.items.map((p: Json) => p.id));
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await ok(client, 'distru-search-products', { sortBy: { field: 'NAME', direction: 'ASC' }, cursor });
      for (const p of page.items) seen.add(p.id);
      cursor = page.nextCursor;
      if (!page.hasMore) expect(page.nextCursor).toBeUndefined();
    }
    expect(seen.size).toBe(42);
    const stale = await call(client, 'distru-search-products', { sortBy: { field: 'NAME', direction: 'DESC' }, cursor: first.nextCursor });
    expect(stale.isError).toBe(true);
    const big = await call(client, 'distru-search-products', { limit: 101 });
    expect(big.isError).toBe(true);
    const hundred = await ok(client, 'distru-search-products', { limit: 100 });
    expect(hundred.items).toHaveLength(42);
    expect(hundred.hasMore).toBe(false);
  });

  test('plain UUIDs accepted, wrong prefixes refused, camelCase fields', async () => {
    const client = await connect();
    const { gummy, vendor } = fixtures();
    const byPlain = await ok(client, 'distru-get-product', { id: gummy.id });
    const byPrefixed = await ok(client, 'distru-get-product', { id: `prd_${gummy.id}` });
    expect(byPlain).toEqual(byPrefixed);
    expect(byPlain.product.sku).toBe('EDB-GUM-WM');
    expect(byPlain.product).toHaveProperty('quantityAvailable');
    expect(byPlain.product).toHaveProperty('inventoryTrackingMethod');
    const wrong = await call(client, 'distru-get-product', { id: `com_${vendor.id}` });
    expect(wrong.isError).toBe(true);
    expect(wrong.body.errors[0].message).toContain('company id');
    expect((await ok(client, 'distru-get-product', { id: 'prd_nope' })).product).toBeNull();
  });

  test('intent + userSatisfactionEstimate are logged; missing or invalid values do not fail the call', async () => {
    const client = await connect();
    await ok(client, 'distru-get-me');
    const r = await call(client, 'distru-search-users', {}, { userSatisfactionEstimate: 9 });
    expect(r.isError).toBe(false);
    expect(r.body.items).toHaveLength(4);
    const t = (await state()).mcp.telemetry as Json[];
    expect(t.at(-2)).toMatchObject({ tool: 'distru-get-me', intent: COMMON.intent, user_satisfaction_estimate: 5, intent_valid: true, satisfaction_valid: true });
    expect(t.at(-1)).toMatchObject({ tool: 'distru-search-users', intent: null, user_satisfaction_estimate: 9, intent_valid: false, satisfaction_valid: false });
  });

  test('reports: rows/meta/nextCursor with maxRowsLimit', async () => {
    const client = await connect();
    const r = await ok(client, 'distru-report-inventory-valuation', { maxRowsLimit: 20, calculationMethod: 'COST' });
    expect(r.rows).toHaveLength(20);
    expect(r.meta).toMatchObject({ report: 'inventory_valuation', rowLimit: 20, offset: 0, rowCount: 20, truncated: true });
    expect(r.meta.totalRowCount).toBe(42);
    const next = await ok(client, 'distru-report-inventory-valuation', { maxRowsLimit: 20, calculationMethod: 'COST', cursor: r.nextCursor });
    expect(next.meta.offset).toBe(20);
    expect(next.rows[0].productId).toStartWith('prd_');
    const assets = await ok(client, 'distru-report-inventory-assets', { locationId: `loc_${fixtures().loc}` });
    expect(assets.rows.length).toBeGreaterThan(0);
    expect(assets.rows.every((x: Json) => x.locationId === `loc_${fixtures().loc}`)).toBe(true);
  });
});

describe('purchase orders: shared store with REST', () => {
  test('MCP CREATE is visible via REST; REST create is visible via MCP', async () => {
    const client = await connect();
    const { purchaseOrder: po } = await createPo(client);
    expect(po.id).toStartWith('po_');
    expect(po.status).toBe('PENDING');
    expect(po.total).toBe('672.00');
    expect(po.orderItems[0]).toMatchObject({ quantity: '96', price: '7.00' });
    const restId = po.id.slice(3);
    const got = await rest(`/purchases/${restId}`);
    expect(got.status).toBe(200);
    expect(got.body.data.items[0].product.sku).toBe('EDB-GUM-WM');
    const listed = await rest(`/purchases?ids[]=${restId}`);
    expect(listed.body.data).toHaveLength(1);

    const { vendor, gummy2, loc } = fixtures();
    const viaRest = await rest('/purchases', {
      method: 'POST',
      body: JSON.stringify({ status: 'PENDING', company_id: vendor.id, location_id: loc, billing_location_id: loc, order_datetime: '2026-11-19T00:00:00Z', due_datetime: '2026-12-19T00:00:00Z', items: [{ product_id: gummy2.id, location_id: loc, quantity: 10, price: 7 }] }),
    });
    const mcpView = await ok(client, 'distru-get-purchase-order', { id: viaRest.body.data.id, includeOrderItems: true });
    expect(mcpView.purchaseOrder.purchaseNumber).toBe(viaRest.body.data.purchase_number);
    expect(mcpView.purchaseOrder.orderItems[0].product.id).toBe(`prd_${gummy2.id}`);
    const search = await ok(client, 'distru-search-purchase-orders', { supplierIds: [`com_${vendor.id}`], status: ['PENDING'] });
    expect(search.items.map((x: Json) => x.id)).toEqual(expect.arrayContaining([po.id, `po_${viaRest.body.data.id}`]));
  });

  test('REST-equivalent validation with camelCase paths', async () => {
    const client = await connect();
    const { vendor, gummy } = fixtures();
    const r = await call(client, 'distru-mutate-purchase-order', { action: 'CREATE', supplierId: `com_${vendor.id}`, orderItems: [{ productId: `prd_${gummy.id}`, quantity: 1, price: 1 }] });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.body)).toContain('intakeLocationId');
    const noOffset = await call(client, 'distru-mutate-purchase-order', { action: 'CREATE', status: 'DRAFT', dueDatetime: '2026-12-19T00:00:00' });
    expect(noOffset.isError).toBe(true);
    const draft = await ok(client, 'distru-mutate-purchase-order', { action: 'CREATE', status: 'DRAFT' });
    expect(draft.purchaseOrder.status).toBe('DRAFT');
  });

  test('UPDATE is sparse; orderItems replace the set ({id} keeps a line)', async () => {
    const client = await connect();
    const { gummy2 } = fixtures();
    const { purchaseOrder: po } = await createPo(client);
    const keep = po.orderItems[0].id as string;
    const desc = await ok(client, 'distru-mutate-purchase-order', { action: 'UPDATE', id: po.id, status: 'PROCESSING' });
    expect(desc.purchaseOrder.description).toBe('Restock via MCP');
    expect(desc.purchaseOrder.orderItems).toHaveLength(1);
    const added = await ok(client, 'distru-mutate-purchase-order', { action: 'UPDATE', id: po.id, orderItems: [{ id: keep }, { productId: `prd_${gummy2.id}`, quantity: 48, price: 7 }] });
    expect(added.purchaseOrder.orderItems).toHaveLength(2);
    const replaced = await ok(client, 'distru-mutate-purchase-order', { action: 'UPDATE', id: po.id, orderItems: [{ productId: `prd_${gummy2.id}`, quantity: 24, price: 6.5 }] });
    expect(replaced.purchaseOrder.orderItems).toHaveLength(1);
    expect(replaced.purchaseOrder.orderItems[0]).toMatchObject({ quantity: '24', price: '6.50', product: { id: `prd_${gummy2.id}` } });
    expect(replaced.purchaseOrder.orderItems[0].id).not.toBe(keep);
    const viaRest = await rest(`/purchases/${po.id.slice(3)}`);
    expect(viaRest.body.data.items).toHaveLength(1);
    expect(viaRest.body.data.status).toBe('PROCESSING');
    const empty = await call(client, 'distru-mutate-purchase-order', { action: 'UPDATE', id: po.id, orderItems: [] });
    expect(empty.isError).toBe(true);
  });

  test('finishing a draft: lines move to the intake location', async () => {
    const client = await connect();
    const { vendor, loc } = fixtures();
    const draft = [...mock.store.purchases.values()].find((p) => p.status === 'DRAFT')!;
    const r = await ok(client, 'distru-mutate-purchase-order', { action: 'UPDATE', id: `po_${draft.id}`, status: 'PENDING', supplierId: `com_${draft.company_id ?? vendor.id}`, intakeLocationId: `loc_${loc}`, dueDatetime: '2026-12-31T00:00:00Z' });
    expect(r.purchaseOrder.status).toBe('PENDING');
    expect(r.purchaseOrder.intakeLocation.id).toBe(`loc_${loc}`);
    expect(r.purchaseOrder.orderItems.every((i: Json) => i.location.id === `loc_${loc}`)).toBe(true);
  });

  test('DELETE removes it everywhere and records a tombstone', async () => {
    const client = await connect();
    const { purchaseOrder: po } = await createPo(client);
    const del = await ok(client, 'distru-mutate-purchase-order', { action: 'DELETE', id: po.id });
    expect(del).toEqual({ id: po.id });
    expect((await rest(`/purchases/${po.id.slice(3)}`)).status).toBe(404);
    expect((await ok(client, 'distru-get-purchase-order', { id: po.id })).purchaseOrder).toBeNull();
    const tomb = await rest(`/deleted-records?record_type=PURCHASE&deleted_datetime=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())},`);
    expect(tomb.body.data.map((d: Json) => d.record_id)).toContain(po.id.slice(3));
    const completedWithTransfer = [...mock.store.purchases.values()].find((p) => p.metrc_transfer_id)!;
    const refused = await call(client, 'distru-mutate-purchase-order', { action: 'DELETE', id: `po_${completedWithTransfer.id}` });
    expect(refused.isError).toBe(true);
  });

  test('record history + activity: MCP writes with source MCP, REST writes with PUBLIC_API', async () => {
    const client = await connect();
    const { purchaseOrder: po } = await createPo(client);
    await ok(client, 'distru-mutate-purchase-order', { action: 'UPDATE', id: po.id, description: 'Changed by MCP' });
    await rest('/purchases', { method: 'POST', body: JSON.stringify({ id: po.id.slice(3), status: 'PROCESSING' }) });
    const hist = await ok(client, 'distru-get-record-history', { recordType: 'PURCHASE', recordId: po.id });
    expect(hist.items).toHaveLength(3);
    expect(hist.items.map((h: Json) => h.source)).toEqual(['PUBLIC_API', 'MCP', 'MCP']);
    const descChange = hist.items[1].rows[0].fields.find((f: Json) => f.field === 'description');
    expect(descChange).toEqual({ field: 'description', label: 'Description', oldValue: 'Restock via MCP', newValue: 'Changed by MCP' });
    expect(hist.items[2].rows.map((r: Json) => r.op)).toEqual(['INSERT', 'INSERT']);
    const restHist = await rest(`/record-history?record_type=PURCHASE&record_id=${po.id.slice(3)}`);
    expect(restHist.body.data.map((h: Json) => h.source)).toEqual(['PUBLIC_API', 'MCP', 'MCP']);
    expect(restHist.body.data[0].rows[0].fields[0]).toMatchObject({ field: 'status', old_value: 'PENDING', new_value: 'PROCESSING' });
    const act = await ok(client, 'distru-search-activity', { sources: ['MCP'] });
    expect(act.items).toHaveLength(2);
    expect(act.items[0].records[0]).toMatchObject({ type: 'PURCHASE', id: po.id });
    expect(act.items[0].records[0].rows[0].fields).toContain('description');
    const restAct = await rest('/activity?sources[]=PUBLIC_API');
    expect(restAct.body.data).toHaveLength(1);
    expect(restAct.body.data[0].actor.name).toBe('Morgan Lee');
  });
});

describe('other writes', () => {
  test('mutate-task links to a PO; visible via REST /tasks and on the purchase', async () => {
    const client = await connect();
    const { purchaseOrder: po } = await createPo(client);
    const users = await ok(client, 'distru-search-users', { search: 'sam' });
    const sam = users.items[0];
    const r = await ok(client, 'distru-mutate-task', { action: 'CREATE', name: 'Confirm delivery date', dueDate: '2026-11-25T17:00:00-08:00', ownerId: sam.id, purchaseOrderId: po.id, color: 'GREEN' });
    expect(r.task).toMatchObject({ name: 'Confirm delivery date', status: 'ACTIVE', relatedType: 'PURCHASE_ORDER', color: 'GREEN', purchaseOrder: { id: po.id }, owner: { id: sam.id } });
    const listed = await rest(`/tasks?ids[]=${r.task.id.slice(5)}`);
    expect(listed.body.data[0]).toMatchObject({ name: 'Confirm delivery date', purchase: { id: po.id.slice(3) }, color: '43A047' });
    expect((await rest(`/purchases/${po.id.slice(3)}`)).body.data.tasks).toHaveLength(1);
    const relink = await call(client, 'distru-mutate-task', { action: 'UPDATE', id: r.task.id, productId: `prd_${fixtures().gummy.id}` });
    expect(relink.isError).toBe(true);
    const done = await ok(client, 'distru-mutate-task', { action: 'UPDATE', id: r.task.id, status: 'COMPLETED' });
    expect(done.task.status).toBe('COMPLETED');
    const found = await ok(client, 'distru-search-tasks', { purchaseOrderIds: [po.id] });
    expect(found.items).toHaveLength(1);
    expect(await ok(client, 'distru-mutate-task', { action: 'DELETE', id: r.task.id })).toEqual({ id: r.task.id });
    expect((await rest(`/tasks/${r.task.id.slice(5)}`)).status).toBe(404);
  });

  test('adjust-inventory on a Metrc package: saved in Distru even when Metrc rejects it', async () => {
    const client = await connect();
    const pkgs = await ok(client, 'distru-search-packages', { withQuantity: true, limit: 1 });
    const pkg = pkgs.items[0];
    expect(pkg.id).toStartWith('pkg_');
    expect(pkg.metrcLabel).toBeString();
    const missing = await call(client, 'distru-adjust-inventory', { packageId: pkg.id, quantity: -1 });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.body)).toContain('complianceReason');
    await config({ metrc_fail_next: 1 });
    const r = await ok(client, 'distru-adjust-inventory', { packageId: pkg.id, quantity: -2, complianceReason: 'Damage', description: 'Crushed in transit' });
    expect(r.stockAdjustment.package.quantity).toBe(String(Number(pkg.quantity) - 2));
    expect(r.stockAdjustment.complianceActivity).toMatchObject({ system: 'METRC', status: 'FAILED' });
    const r2 = await ok(client, 'distru-adjust-inventory', { packageId: pkg.id, quantity: -1, complianceReason: 'Damage', description: 'Another one' });
    expect(r2.stockAdjustment.complianceActivity.status).toBe('SUCCESS');
    const hist = await ok(client, 'distru-get-record-history', { recordType: 'PACKAGE', recordId: pkg.id });
    expect(hist.items).toHaveLength(2);
    expect(hist.items[0].source).toBe('MCP');
  });

  test('email-pdf records to the outbox, never sends; refuses drafts', async () => {
    const client = await connect();
    const { purchaseOrder: po } = await createPo(client);
    const r = await ok(client, 'distru-email-pdf', { document: 'PURCHASE_ORDER', id: po.id, emailAddresses: ['orders@gse.example, buyer@gse.example'] });
    expect(r.emailedTo).toEqual(['orders@gse.example', 'buyer@gse.example']);
    const outbox = (await state()).outbox as Json[];
    expect(outbox.at(-1)).toMatchObject({ source: 'MCP', document: 'PURCHASE_ORDER', record_id: po.id.slice(3), to: ['orders@gse.example', 'buyer@gse.example'] });
    const draft = [...mock.store.purchases.values()].find((p) => p.status === 'DRAFT')!;
    expect((await call(client, 'distru-email-pdf', { document: 'PURCHASE_ORDER', id: `po_${draft.id}`, emailAddresses: ['a@b.co'] })).isError).toBe(true);
  });

  test('read tools over the rest of the catalogue', async () => {
    const client = await connect();
    const companies = await ok(client, 'distru-search-companies', { isMyCompany: true });
    expect(companies.items).toHaveLength(1);
    expect(companies.items[0]).toMatchObject({ isMyCompany: true, name: 'Golden Coast Distribution' });
    const vendor = await ok(client, 'distru-get-company', { id: `com_${fixtures().vendor.id}`, includeLocations: true, includeLicenses: true });
    expect(vendor.company.locations[0].id).toStartWith('loc_');
    expect(vendor.company.licenses[0].licenseNumber).toBeString();
    const failed = await ok(client, 'distru-search-packages', { labTestingStates: ['FAILED'], status: 'ANY' });
    expect(failed.items.length).toBeGreaterThan(0);
    const pkg = await ok(client, 'distru-get-package', { id: failed.items[0].id });
    expect(pkg.package.labTestingState).toBe('FAILED');
    const tests = await ok(client, 'distru-search-test-results', { batchIds: [failed.items[0].batch.id] });
    expect(tests.items[0].name).toContain('FAILED');
    const orders = await ok(client, 'distru-search-sales-orders', { status: ['PENDING', 'PROCESSING'], limit: 5 });
    expect(orders.items.length).toBeGreaterThan(0);
    const so = await ok(client, 'distru-get-sales-order', { id: orders.items[0].id, includeOrderItems: true });
    expect(so.salesOrder.orderItems[0].product.id).toStartWith('prd_');
    const tasks = await ok(client, 'distru-search-tasks', { statuses: ['ACTIVE'] });
    expect(tasks.items.length).toBe(3);
  });
});

describe('rate limits', () => {
  test('429 + Retry-After + JSON-RPC error naming the limit; the SDK client surfaces it', async () => {
    expect((await config({ mcp_rate_limit: { fail_next: 1, retry_after: 7 } })).status).toBe(200);
    const r = await rawCall('distru-get-me');
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('7');
    const body = (await r.json()) as Json;
    expect(body.error.message).toContain('Rate limit exceeded');
    expect(body.error.data.limit).toBe('simulated');
    const okRes = await rawCall('distru-get-me');
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get('ratelimit-remaining')).toBe('39');
    await config({ mcp_rate_limit: { fail_next: 1 } });
    const client = await connect();
    await expect(client.callTool({ name: 'distru-get-me', arguments: COMMON })).rejects.toThrow();
  });

  test('burst bucket, write limit and in-flight limit', async () => {
    await config({ mcp_rate_limit: { burst: 2, per_minute: 1 } });
    expect((await rawCall('distru-get-me')).status).toBe(200);
    expect((await rawCall('distru-get-me')).status).toBe(200);
    const third = await rawCall('distru-get-me');
    expect(third.status).toBe(429);
    expect(((await third.json()) as Json).error.data.limit).toBe('burst');
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    await config({ mcp_rate_limit: { burst: 40, per_minute: 120, writes_per_minute: 1 } });
    const write = () => rawCall('distru-mutate-task', { action: 'CREATE', name: 'x', dueDate: '2026-12-01T00:00:00-08:00' });
    expect((await write()).status).toBe(200);
    const second = await write();
    expect(second.status).toBe(429);
    expect(((await second.json()) as Json).error.data.limit).toBe('writes_per_minute');
    expect((await rawCall('distru-get-me')).status).toBe(200); // reads unaffected

    await config({ mcp_rate_limit: { max_in_flight: 1, latency_ms: 40 } });
    const [a, b] = await Promise.all([rawCall('distru-get-me', {}, 1), rawCall('distru-get-me', {}, 2)]);
    expect([a.status, b.status].sort()).toEqual([200, 429]);
    const refused = a.status === 429 ? a : b;
    expect(refused.headers.get('ratelimit-remaining')).toBeNull();
  });

  test('a batch of more than 6 tool calls is a 400', async () => {
    const batch = Array.from({ length: 7 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'distru-get-me', arguments: COMMON } }));
    const r = await raw(batch);
    expect(r.status).toBe(400);
  });
});
