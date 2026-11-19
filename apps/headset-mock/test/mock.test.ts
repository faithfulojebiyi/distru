import { beforeEach, describe, expect, test } from 'bun:test';
import { createHeadsetMock, SCENARIO_SKUS, type HeadsetMock } from '../src/app';

const NOW = '2026-11-19T12:00:00Z'; // a Thursday → latest complete week starts Mon 2026-11-09
const AUTH = { Authorization: 'Bearer headset-mock-token' };

let mock: HeadsetMock;
beforeEach(() => {
  mock = createHeadsetMock({ now: NOW });
});

async function get<T = any>(path: string, headers: Record<string, string> = AUTH): Promise<{ status: number; body: T }> {
  const res = await mock.app.request(path, { headers });
  return { status: res.status, body: (await res.json()) as T };
}
const trend = async (sku: string) => (await get(`/v1/trends?skus[]=${sku}`)).body.data[0];

describe('auth + health', () => {
  test('health is open; /v1 needs the bearer token', async () => {
    expect((await get('/health', {})).body).toMatchObject({ ok: true, scenario: 'default', latest_week: '2026-11-09' });
    expect((await get('/v1/stores', {})).status).toBe(401);
    expect((await get('/v1/stores', { Authorization: 'Bearer nope' })).status).toBe(401);
    expect((await get('/v1/stores')).status).toBe(200);
  });

  test('custom token', async () => {
    const m = createHeadsetMock({ token: 'secret', now: NOW });
    expect((await m.app.request('/v1/stores', { headers: { Authorization: 'Bearer secret' } })).status).toBe(200);
  });
});

describe('stores + products', () => {
  test('10 stores with cursor paging', async () => {
    const first = await get('/v1/stores?limit=4');
    expect(first.body.data).toHaveLength(4);
    expect(first.body.total).toBe(10);
    const ids = first.body.data.map((s: { id: string }) => s.id);
    let cursor = first.body.next_cursor;
    while (cursor) {
      const next = await get(`/v1/stores?limit=4&cursor=${cursor}`);
      ids.push(...next.body.data.map((s: { id: string }) => s.id));
      cursor = next.body.next_cursor;
    }
    expect(new Set(ids).size).toBe(10);
    expect((await get('/v1/stores?cursor=garbage')).status).toBe(400);
    expect((await get('/v1/stores?limit=0')).status).toBe(400);
  });

  test('product search by name', async () => {
    const { body } = await get('/v1/products?q=blue%20dream');
    expect(body.data.map((p: { sku: string }) => p.sku)).toContain('VAP-BD-1G');
  });
});

describe('sell-through', () => {
  test('weekly series per SKU per store, both skus[] and comma syntax', async () => {
    const { body } = await get('/v1/sell-through?skus[]=VAP-BD-1G&weeks=4');
    expect(body.week_starts).toEqual(['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09']);
    expect(body.data).toHaveLength(10); // every store carries it
    const row = body.data[0];
    expect(row).toMatchObject({ sku: 'VAP-BD-1G', product_name: 'Blue Dream Live Resin Cart 1g' });
    expect(row.weeks).toHaveLength(4);
    for (const w of row.weeks) {
      expect(w.days_on_shelf + w.oos_days).toBe(7);
      expect(w.revenue).toBeCloseTo(w.units * (w.avg_retail_price ?? 0), 1);
    }
    const comma = await get('/v1/sell-through?skus=VAP-BD-1G,PRE-BD-1G&store_ids[]=st_elevate_la');
    expect(comma.body.data.map((r: { sku: string }) => r.sku)).toEqual(['VAP-BD-1G', 'PRE-BD-1G']);
  });

  test('validation', async () => {
    expect((await get('/v1/sell-through?skus[]=NOPE')).status).toBe(400);
    expect((await get('/v1/sell-through?store_ids[]=nope')).status).toBe(400);
    expect((await get('/v1/sell-through?weeks=17')).status).toBe(400);
  });

  test('deterministic across instances', async () => {
    const a = await get('/v1/sell-through?skus[]=FLW-BD-35');
    mock = createHeadsetMock({ now: NOW });
    expect((await get('/v1/sell-through?skus[]=FLW-BD-35')).body).toEqual(a.body);
  });
});

describe('scenario trends (default)', () => {
  test('Blue Dream cart + pre-roll surge ~45%+ over the last 3 weeks across ≥6 stores', async () => {
    for (const sku of SCENARIO_SKUS.surging) {
      const t = await trend(sku);
      expect(t.growth_3w_pct).toBeGreaterThanOrEqual(40);
      expect(t.growth_3w_pct).toBeLessThanOrEqual(60);
      expect(t.stores_carrying).toBeGreaterThanOrEqual(6);
      // the lift shows at store level, not just one outlier store
      const { body } = await get(`/v1/sell-through?skus[]=${sku}&weeks=6`);
      const lifted = body.data.filter((r: { weeks: { units: number }[] }) => {
        const u = r.weeks.map((w) => w.units);
        return u[3]! + u[4]! + u[5]! > 1.2 * (u[0]! + u[1]! + u[2]!);
      });
      expect(lifted.length).toBeGreaterThanOrEqual(6);
    }
  });

  test('OG Kush 3.5g surges at retail', async () => {
    expect((await trend(SCENARIO_SKUS.surging_wholesale_ok)).growth_3w_pct).toBeGreaterThanOrEqual(40);
  });

  test('milk chocolate declines', async () => {
    const t = await trend(SCENARIO_SKUS.declining);
    expect(t.growth_3w_pct).toBeLessThan(-15);
  });

  test('watermelon gummies: stock-out days rising, in-stock velocity flat, raw units down', async () => {
    const t = await trend(SCENARIO_SKUS.oos_rising);
    expect(t.oos_days_last_3w).toBeGreaterThanOrEqual(2 * t.oos_days_prior_3w);
    expect(Math.abs(t.growth_3w_pct)).toBeLessThan(10);
    expect(t.units_growth_3w_pct).toBeLessThan(-20);
  });

  test('everything else stays flat (|3-week growth| < 10%)', async () => {
    const { body } = await get('/v1/trends?limit=200');
    const special = new Set<string>([...SCENARIO_SKUS.surging, SCENARIO_SKUS.surging_wholesale_ok, SCENARIO_SKUS.declining, SCENARIO_SKUS.discontinued]);
    for (const t of body.data) {
      if (special.has(t.sku)) continue;
      expect(Math.abs(t.growth_3w_pct)).toBeLessThan(10);
    }
  });

  test('discontinued SKU has no current shelf presence', async () => {
    const t = await trend(SCENARIO_SKUS.discontinued);
    expect(t).toMatchObject({ units_last_4w: 0, stores_carrying: 0, oos_days_last_3w: 0, growth_3w_pct: null });
  });

  test('top movers: 28d up-movers led by the surging SKUs; direction filter + validation', async () => {
    const up = await get('/v1/top-movers?window=28d&direction=up&limit=3');
    expect(up.body.data.map((r: { sku: string }) => r.sku).sort()).toEqual(['FLW-OGK-35', 'PRE-BD-1G', 'VAP-BD-1G']);
    const down = await get('/v1/top-movers?window=28d&direction=down&limit=5');
    const downSkus = down.body.data.map((r: { sku: string }) => r.sku);
    expect(downSkus).toContain('EDB-CHO-MS');
    expect(downSkus).toContain('EDB-GUM-WM');
    expect((await get('/v1/top-movers?window=1y')).status).toBe(400);
  });
});

describe('scenarios', () => {
  const reset = (body: unknown) => mock.app.request('/__mock/reset', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });

  test('no-reorder-needed: flat retail everywhere', async () => {
    expect((await reset({ scenario: 'no-reorder-needed' })).status).toBe(200);
    for (const sku of [...SCENARIO_SKUS.surging, SCENARIO_SKUS.surging_wholesale_ok, SCENARIO_SKUS.declining]) {
      expect(Math.abs((await trend(sku)).growth_3w_pct)).toBeLessThan(10);
    }
  });

  test('no-retail-signal: stores exist, no sell-through', async () => {
    await reset({ scenario: 'no-retail-signal' });
    expect((await get('/v1/stores')).body.total).toBe(10);
    expect((await get('/v1/sell-through?skus[]=VAP-BD-1G')).body.data).toEqual([]);
    const t = await trend('VAP-BD-1G');
    expect(t).toMatchObject({ has_data: false, units_last_4w: 0, growth_3w_pct: null, stores_carrying: 0 });
    expect((await get('/v1/top-movers')).body.data).toEqual([]);
  });

  test('distru-mock scenario names are accepted; unknown rejected; reset back to default', async () => {
    for (const s of ['clean', 'failed-lab-test', 'prompt-injection']) expect((await reset({ scenario: s })).status).toBe(200);
    expect((await reset({ scenario: 'bogus' })).status).toBe(400);
    await reset({ scenario: 'default' });
    expect((await trend('VAP-BD-1G')).growth_3w_pct).toBeGreaterThan(40);
    expect(mock.scenario).toBe('default');
  });
});
