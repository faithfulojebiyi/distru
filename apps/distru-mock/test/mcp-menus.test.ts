/** DistruCommerce menus over the MCP mock: seeded menus, live availability, per-buyer caps, mutate-menu. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMockServer, type MockServer } from '../src/app';
import { CAPPED_SKU, VIP_ONLY_SKUS } from '../src/menus';

const BASE = 'http://mock.test';
const COMMON = { intent: 'Cap how many units an account can order of a hot SKU', userSatisfactionEstimate: 5 };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let mock: MockServer;
let client: Client;

beforeEach(async () => {
  mock = createMockServer({ now: '2026-11-19T12:00:00Z' });
  client = new Client({ name: 'menus-test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { fetch: (u, i) => Promise.resolve(mock.app.request(String(u), i)), requestInit: { headers: { Authorization: 'Bearer distru_mcp_test' } } }),
  );
});
afterEach(() => client.close());

async function call(name: string, args: Json = {}) {
  const r = (await client.callTool({ name, arguments: { ...COMMON, ...args } })) as { isError?: boolean; content: { text: string }[] };
  return { isError: !!r.isError, body: JSON.parse(r.content[0]!.text) as Json };
}
async function ok(name: string, args: Json = {}) {
  const r = await call(name, args);
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.body)}`);
  return r.body;
}
const simulate = (body: unknown) => mock.app.request(`${BASE}/__mock/simulate/order`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const bySku = (sku: string) => [...mock.store.products.values()].find((p) => p.sku === sku)!;

async function menus() {
  const list = await ok('distru-search-menus', { sortBy: { field: 'NAME', direction: 'ASC' } });
  const wholesale = list.items.find((m: Json) => m.name === 'California Wholesale');
  const vip = list.items.find((m: Json) => m.name === 'VIP Reserve');
  return { list, wholesale, vip };
}

describe('seeded menus', () => {
  test('a public wholesale menu and a private VIP menu, products placed from the catalog', async () => {
    const { list, wholesale, vip } = await menus();
    expect(list.items).toHaveLength(2);
    expect(wholesale).toMatchObject({ visibility: 'PUBLIC', active: true, discoverable: true, minimumOrderSubtotal: '500.00' });
    expect(vip).toMatchObject({ visibility: 'PRIVATE', active: true, discoverable: false, sellByCaseOnly: false });
    expect(wholesale.id).toStartWith('menu_');
    const settings = await ok('distru-get-menu-settings', { id: vip.id, includeCollections: true });
    expect(settings.menu.locations).toHaveLength(1);
    expect(settings.menu.collections.map((c: Json) => c.name)).toContain('Limited allocation');
    expect(settings.menu.officialCollections.map((c: Json) => c.officialCollectionName)).toContain('All Products');

    const vipProducts = await ok('distru-search-menu-products', { menuId: vip.id, limit: 100 });
    const wholesaleProducts = await ok('distru-search-menu-products', { menuId: wholesale.id, limit: 100 });
    const vipOnly = VIP_ONLY_SKUS.map((s) => `prd_${bySku(s).id}`);
    expect(vipProducts.items.map((p: Json) => p.id)).toEqual(expect.arrayContaining(vipOnly));
    expect(wholesaleProducts.items.some((p: Json) => vipOnly.includes(p.id))).toBe(false);
    // REST product shows which menus it is on
    const rest = await mock.app.request(`${BASE}/public/v1/products/${bySku(VIP_ONLY_SKUS[0]!).id}`, { headers: { Authorization: 'Bearer mock-token' } });
    const prod = ((await rest.json()) as Json).data;
    expect(prod.menu_visibility).toBe('INCLUDE_IN_SELECT');
    expect(prod.menus.map((m: Json) => m.name)).toEqual(['VIP Reserve']);
  });

  test('menu availability is live inventory at the menu locations (active − reserved)', async () => {
    const { wholesale } = await menus();
    const blue = bySku('FLW-BD-35');
    const before = (await ok('distru-search-menu-products', { menuId: wholesale.id, productIds: [`prd_${blue.id}`] })).items[0];
    const s = mock.store;
    expect(Number(before.quantityAvailable)).toBe(s.quantityActive(blue.id, s.ownLocationIds) - s.quantityReserved(blue.id, s.ownLocationIds));
    // a sales order reserves stock → less available on the menu
    expect((await simulate({ items: [{ sku: 'FLW-BD-35', quantity: 24 }] })).status).toBe(201);
    const after = (await ok('distru-search-menu-products', { menuId: wholesale.id, productIds: [`prd_${blue.id}`] })).items[0];
    expect(Number(after.quantityAvailable)).toBe(Math.max(0, Number(before.quantityAvailable) - 24));
    expect(after.soldOut).toBe(Number(after.quantityAvailable) <= 0);
    expect(after.category.officialProductCategory.id).toBe('FLOWER');
  });

  test('collections list products by official category; collectionId returns one with its products', async () => {
    const { wholesale } = await menus();
    const cols = await ok('distru-search-menu-collections', { menuId: wholesale.id, limit: 50 });
    const flower = cols.items.find((c: Json) => c.name === 'Flower' && !c.official);
    expect(flower.productCount).toBeGreaterThan(0);
    const one = await ok('distru-search-menu-collections', { menuId: wholesale.id, collectionId: flower.id });
    expect(one.items).toHaveLength(1);
    expect(one.items[0].products.every((p: Json) => p.category.officialProductCategory.id === 'FLOWER')).toBe(true);
  });
});

describe('per-buyer caps (maxMenuBuyerOrderQuantity)', () => {
  test('seeded cap shows on the menu; mutate-product sets a new one, visible everywhere, recorded with source MCP', async () => {
    const { wholesale, vip } = await menus();
    const capped = bySku(CAPPED_SKU.sku);
    const vipRow = (await ok('distru-search-menu-products', { menuId: vip.id, productIds: [`prd_${capped.id}`] })).items[0];
    expect(vipRow.maxMenuBuyerOrderQuantity).toBe(CAPPED_SKU.max);

    const gummy = bySku('EDB-GUM-WM');
    const r = await ok('distru-mutate-product', { action: 'UPDATE', id: `prd_${gummy.id}`, maxMenuBuyerOrderQuantity: 48 });
    expect(r.product.maxMenuBuyerOrderQuantity).toBe(48);
    expect(r.product.menus.map((m: Json) => m.name).sort()).toEqual(['California Wholesale', 'VIP Reserve']);
    const row = (await ok('distru-search-menu-products', { menuId: wholesale.id, productIds: [`prd_${gummy.id}`] })).items[0];
    expect(row.maxMenuBuyerOrderQuantity).toBe(48);
    expect((await ok('distru-get-product', { id: `prd_${gummy.id}` })).product.maxMenuBuyerOrderQuantity).toBe(48);
    const hist = await ok('distru-get-record-history', { recordType: 'PRODUCT', recordId: `prd_${gummy.id}` });
    expect(hist.items[0].source).toBe('MCP');
    expect(hist.items[0].rows[0].fields).toContainEqual({ field: 'max_menu_buyer_order_quantity', label: 'Max menu buyer order quantity', oldValue: null, newValue: 48 });
    const state = (await (await mock.app.request(`${BASE}/__mock/state`)).json()) as Json;
    expect(state.buyer_caps).toContainEqual({ product_id: gummy.id, sku: 'EDB-GUM-WM', max_menu_buyer_order_quantity: 48 });

    expect((await call('distru-mutate-product', { action: 'UPDATE', id: `prd_${gummy.id}`, maxMenuBuyerOrderQuantity: 0 })).isError).toBe(true);
    const cleared = await ok('distru-mutate-product', { action: 'UPDATE', id: `prd_${gummy.id}`, maxMenuBuyerOrderQuantity: null });
    expect(cleared.product.maxMenuBuyerOrderQuantity).toBeNull();
  });

  test('a buyer order over the cap is rejected; sales reps are exempt', async () => {
    const { vip } = await menus();
    const capped = bySku(CAPPED_SKU.sku);
    const menuId = vip.id.slice('menu_'.length);
    const over = await simulate({ menu_id: menuId, items: [{ product_id: capped.id, quantity: CAPPED_SKU.max + 1 }] });
    expect(over.status).toBe(400);
    const err = ((await over.json()) as Json).errors[0];
    expect(err.pointer).toEqual(['items', 0, 'quantity']);
    expect(err.message).toContain(`(${CAPPED_SKU.max})`);
    const atCap = await simulate({ menu_id: menuId, items: [{ product_id: capped.id, quantity: 2 }] });
    expect(atCap.status).toBe(201);
    expect(((await atCap.json()) as Json).data.menu).toEqual({ id: menuId, name: 'VIP Reserve' });
    const rep = await simulate({ menu_id: menuId, placed_by: 'sales_rep', items: [{ product_id: capped.id, quantity: CAPPED_SKU.max + 1 }] });
    // sales reps skip the cap (they may still hit availability)
    if (rep.status !== 201) expect(((await rep.json()) as Json).errors.every((e: Json) => !String(e.message).includes('one buyer may order'))).toBe(true);
    // not on the menu
    const wholesaleOnly = bySku('ACC-BAT-BLK');
    const offMenu = await simulate({ menu_id: menuId, items: [{ product_id: bySku('FLW-BD-35').id, quantity: 1 }, { product_id: wholesaleOnly.id, quantity: 1 }] });
    expect(offMenu.status).toBe(201); // INCLUDE_IN_ALL products are on every menu
  });
});

describe('distru-mutate-menu', () => {
  test('CREATE with defaults, UPDATE sparse, validation, no DELETE', async () => {
    const { tools } = await client.listTools();
    const mm = tools.find((t) => t.name === 'distru-mutate-menu')!;
    expect(mm._meta).toMatchObject({ distru: { kind: 'write', reaches: [] } });
    expect(((mm.inputSchema.properties as Json).action.enum as string[]).sort()).toEqual(['CREATE', 'UPDATE']);
    const loc = mock.store.ownLocationIds[1]!;
    expect((await call('distru-mutate-menu', { action: 'CREATE', name: 'SoCal Wholesale' })).isError).toBe(true); // locationIds required
    const created = await ok('distru-mutate-menu', { action: 'CREATE', name: 'SoCal Wholesale', locationIds: [`loc_${loc}`] });
    expect(created.menu).toMatchObject({ name: 'SoCal Wholesale', externalName: 'SoCal Wholesale', active: false, visibility: 'PUBLIC', sellByCaseOnly: true, defaultOrderStatus: 'Pending' });
    expect(created.menu.primaryUrl).toEndWith('/socal-wholesale');
    expect(created.menu.collections[0].name).toBe('Featured Products');
    const dup = await call('distru-mutate-menu', { action: 'CREATE', name: 'socal wholesale', locationIds: [`loc_${loc}`] });
    expect(dup.isError).toBe(true);
    const upd = await ok('distru-mutate-menu', { action: 'UPDATE', id: created.menu.id, active: true, minimumOrderSubtotal: 750, collections: [{ name: 'Edibles under 10mg', officialProductCategoryIds: ['EDIBLES'], thcRange: { max: 10, unit: 'MG' } }] });
    expect(upd.menu).toMatchObject({ active: true, minimumOrderSubtotal: '750.00', sellByCaseOnly: true });
    expect(upd.menu.collections).toHaveLength(1);
    expect(upd.menu.collections[0].thcRange).toEqual({ max: '10', unit: 'MG' });
    const pass = await call('distru-mutate-menu', { action: 'UPDATE', id: created.menu.id, visibility: 'PASSCODE_PROTECTED' });
    expect(pass.isError).toBe(true);
    const ok2 = await ok('distru-mutate-menu', { action: 'UPDATE', id: created.menu.id, visibility: 'PASSCODE_PROTECTED', passcode: 'vip2026' });
    expect(ok2.menu.visibility).toBe('PASSCODE_PROTECTED');
    expect(JSON.stringify(ok2.menu)).not.toContain('vip2026');
    expect((await call('distru-mutate-menu', { action: 'UPDATE', id: created.menu.id, allowCustomersToOverOrder: true })).isError).toBe(true);
    expect((await call('distru-mutate-menu', { action: 'DELETE', id: created.menu.id })).isError).toBe(true);
    const hidden = await ok('distru-mutate-menu', { action: 'UPDATE', id: created.menu.id, hidePricesMode: 'HIDE_FOR_EVERYONE' });
    expect(hidden.menu.minimumOrderSubtotal).toBeNull();
    const hist = await ok('distru-get-record-history', { recordType: 'MENU', recordId: created.menu.id });
    expect(hist.items.length).toBe(4); // create + 3 successful updates
    expect(hist.items.every((h: Json) => h.source === 'MCP')).toBe(true);
    const state = (await (await mock.app.request(`${BASE}/__mock/state`)).json()) as Json;
    expect(state.menus.map((m: Json) => m.name)).toContain('SoCal Wholesale');
  });

  test('mutate-product moves a product onto one menu only (INCLUDE_IN_SELECT)', async () => {
    const { wholesale, vip } = await menus();
    const battery = bySku('ACC-BAT-BLK');
    expect((await call('distru-mutate-product', { action: 'UPDATE', id: `prd_${battery.id}`, menuVisibility: 'INCLUDE_IN_SELECT' })).isError).toBe(true);
    await ok('distru-mutate-product', { action: 'UPDATE', id: `prd_${battery.id}`, menuVisibility: 'INCLUDE_IN_SELECT', menus: [wholesale.id] });
    const onVip = await ok('distru-search-menu-products', { menuId: vip.id, productIds: [`prd_${battery.id}`] });
    expect(onVip.items).toHaveLength(0);
    const onWholesale = await ok('distru-search-products', { menuIds: [wholesale.id], ids: [`prd_${battery.id}`] });
    expect(onWholesale.items).toHaveLength(1);
    expect((await call('distru-mutate-product', { action: 'UPDATE', id: `prd_${battery.id}`, upc: '123' })).isError).toBe(true);
  });
});
