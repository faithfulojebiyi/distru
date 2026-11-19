import { describe, expect, test } from 'bun:test';
import { createMockServer, LOW_STOCK_SKUS, SCENARIOS } from '../src/app';
import { seedStore, type ScenarioName } from '../src/seed';
import { inventoryVelocityReport } from '../src/velocity';

const NOW = new Date('2026-11-19T12:00:00Z');
const AUTH = { Authorization: 'Bearer mock-token' };
const LOW = [...LOW_STOCK_SKUS].sort();

const below = (scenario: ScenarioName, lead: number, locationId?: string) =>
  inventoryVelocityReport(seedStore(scenario, NOW), { lead_time_days: lead, below_reorder_point: true, location_ids: locationId ? [locationId] : undefined }).data;

describe('per-location stock is consistent with the scenario', () => {
  const store = seedStore('default', NOW);
  const [OAK, LA, SAC] = store.ownLocationIds as [string, string, string];

  test('default / clean: every location shows a handful of at-risk SKUs, all canonical', () => {
    for (const scenario of ['default', 'clean', 'failed-lab-test', 'prompt-injection'] as const) {
      for (const loc of [OAK, LA, SAC]) {
        for (const lead of [7, 14, 21]) {
          const rows = below(scenario, lead, loc);
          expect(rows.length).toBeLessThanOrEqual(LOW.length);
          expect(rows.every((r) => LOW_STOCK_SKUS.includes(r.sku))).toBe(true);
          expect(rows.filter((r) => r.reorder_status === 'LATE').length).toBeLessThanOrEqual(LOW.length);
        }
      }
      // at the calibration lead time the branches show exactly the canonical eight, Oakland seven or eight
      expect(below(scenario, 14, LA).map((r) => r.sku).sort()).toEqual(LOW);
      expect(below(scenario, 14, SAC).map((r) => r.sku).sort()).toEqual(LOW);
      expect(below(scenario, 14, OAK).length).toBeGreaterThanOrEqual(7);
      // company-wide stays the canonical eight at 7–21 days of lead time
      for (const lead of [7, 14, 21]) expect(below(scenario, lead).map((r) => r.sku).sort()).toEqual(LOW);
    }
  });

  test('no-reorder-needed: nothing below reorder at any location or lead time', () => {
    for (const loc of [undefined, OAK, LA, SAC]) for (const lead of [7, 14, 21]) expect(below('no-reorder-needed', lead, loc)).toEqual([]);
  });

  test('hazards hold at every location: the failed batch is on hold wherever it is stocked', () => {
    const s = seedStore('default', NOW);
    const failed = s.summary!.failed_lab_test!;
    const held = [...s.lots.values()].filter((l) => l.batch_id === failed.batch_id && l.quantity > 0);
    expect(held.length).toBeGreaterThan(0);
    expect(held.every((l) => l.on_hold)).toBe(true);
    expect(seedStore('clean', NOW).summary!.failed_lab_test).toBeNull();
    expect([...seedStore('clean', NOW).lots.values()].some((l) => l.on_hold)).toBe(false);
  });

  test('every branch with sales holds stock (no phantom LATE rows from empty shelves)', () => {
    for (const loc of [LA, SAC]) {
      const rows = inventoryVelocityReport(seedStore('no-reorder-needed', NOW), { lead_time_days: 14, location_ids: [loc] }).data;
      expect(rows.length).toBeGreaterThan(30);
      expect(rows.every((r) => r.reorder_status === 'OK' || r.reorder_status === 'NO_RECENT_SALES')).toBe(true);
    }
  });

  test('ids are deterministic; catalog, batches, orders and branch packages match across scenarios', () => {
    const ids = (sc: ScenarioName) => {
      const st = seedStore(sc, NOW);
      const [, la, sac] = st.ownLocationIds;
      return {
        products: [...st.products.keys()],
        batches: [...st.batches.keys()],
        orders: [...st.orders.keys()],
        branchLots: [...st.lots.values()].filter((l) => (l.location_id === la || l.location_id === sac) && l.inserted_datetime.endsWith('T14:00:00.000Z')).map((l) => l.id),
      };
    };
    const a = ids('default');
    expect(ids('default')).toEqual(a);
    for (const sc of Object.keys(SCENARIOS) as ScenarioName[]) {
      const b = ids(sc);
      expect(b.products).toEqual(a.products);
      expect(b.batches).toEqual(a.batches);
      expect(b.orders).toEqual(a.orders);
      // branch packages: same id for the same product/location whenever both scenarios stock it
      expect(b.branchLots.filter((id) => a.branchLots.includes(id)).length).toBeGreaterThan(0);
    }
    // every low-stock scenario shares every id (only data differs)
    const full = (sc: ScenarioName) => {
      const st = seedStore(sc, NOW);
      return [st.purchases, st.testResults, st.lots].map((m) => [...m.keys()]);
    };
    const d = full('default');
    for (const sc of ['clean', 'failed-lab-test', 'prompt-injection'] as const) expect(full(sc)).toEqual(d);
  });
});

describe('velocity report after many writes (vendor-reply regression)', () => {
  test('rows keep coming back after dozens of PO creates/updates; only a lead-less below_reorder_point filter is empty', async () => {
    const mock = createMockServer({ now: NOW.toISOString(), webhookRetryDelaysMs: [] });
    const s = mock.store;
    const [OAK] = s.ownLocationIds as [string];
    const product = [...s.products.values()].find((p) => p.sku === 'EDB-GUM-WM')!;
    const req = (path: string, body?: unknown) =>
      mock.app.request(`http://mock.test${path}`, body === undefined ? { headers: AUTH } : { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const r = await req('/public/v1/purchases', {
        status: 'PENDING',
        company_id: product.vendor_id,
        location_id: OAK,
        billing_location_id: OAK,
        order_datetime: NOW.toISOString(),
        due_datetime: '2026-12-19T00:00:00Z',
        items: [{ product_id: product.id, location_id: OAK, quantity: 48, price: 7 }],
      });
      expect(r.status).toBe(200);
      ids.push(((await r.json()) as { data: { id: string } }).data.id);
    }
    for (const id of ids) expect((await req('/public/v1/purchases', { id, items: [{ product_id: product.id, location_id: OAK, quantity: 24, price: 7 }] })).status).toBe(200);
    const url = `/public/v1/reports/inventory-velocity?location_ids[]=${OAK}&product_ids[]=${product.id}`;
    const report = async (q: string) => ((await (await req(`${url}${q}`)).json()) as { data: { sku: string; quantity_incoming: string; below_reorder_point: boolean | null }[] }).data;

    // the vendor-reply workflow's call: below_reorder_point=false without lead_time_days → empty by Distru's spec
    expect(await report('&below_reorder_point=false')).toEqual([]);
    // what it needs: no below_reorder_point filter (and a lead time) → the row, with the updated incoming
    const both = await report('&lead_time_days=14');
    expect(both).toHaveLength(1);
    expect(both[0]!.quantity_incoming).toBe(String(25 * 24));
    expect(await report('')).toHaveLength(1);
    // company-wide below-reorder list still non-empty after the writes
    const companyBelow = ((await (await req('/public/v1/reports/inventory-velocity?lead_time_days=14&below_reorder_point=true')).json()) as { data: { sku: string }[] }).data;
    expect(companyBelow.map((r) => r.sku).sort()).toEqual(LOW);
  });
});
