import { describe, expect, test } from 'bun:test';
import { buildProfile, contextFor, ingestHeadsetTrends, parseLeadTimeDays } from '../src';
import { setup } from './setup';

async function synced() {
  const env = setup();
  await env.sync.run();
  return env;
}

describe('account profile', () => {
  test('vendor lead times match the mock’s true lead times; promised parsed from PO notes', async () => {
    const env = await synced();
    const profile = await buildProfile(env.store, { clock: env.clock });
    const truth = (await env.mockState()).vendors;
    expect(truth.length).toBe(6);
    for (const v of truth) {
      const p = profile.vendors.find((x) => x.vendorId === v.id)!;
      expect(p).toBeDefined();
      expect(Math.round(p.actualLeadTimeDays!)).toBe(v.typical_lead_time_days);
      expect(p.promisedLeadTimeDays).toBe(v.typical_lead_time_days);
      expect(p.leadTimeSamples).toBeGreaterThanOrEqual(2);
      expect(p.onTimePct).toBe(100);
      expect(p.fillRatePct).toBe(100);
      expect(p.priceTrends.length).toBeGreaterThan(0);
    }
    const gse = profile.vendors.find((x) => x.name === 'Golden State Edibles')!;
    expect(gse.openPurchaseCount).toBe(1);
  });

  test('product demand trend, weekday seasonality, stock and days of supply', async () => {
    const env = await synced();
    const profile = await buildProfile(env.store, { clock: env.clock });
    const bySku = new Map(profile.products.map((p) => [p.sku, p]));
    // low-stock SKUs were seeded trending up (×1.35 over the last 30 days)
    const hot = bySku.get('PRE-BD-1G')!;
    expect(hot.demandDirection).toBe('up');
    expect(hot.demandTrendPct!).toBeGreaterThan(10);
    expect(hot.unitsPerDay28d).toBeGreaterThan(14);
    // the seed sells ~20% more on Fri/Sat and ~40% less on Sunday
    expect(hot.seasonalityHint).toContain('Fri');
    expect(hot.seasonalityHint).toContain('Sun');
    expect(hot.available).not.toBeNull();
    expect(hot.daysOfSupply).not.toBeNull();
    // discontinued SKU: inactive, no recent demand
    const dead = bySku.get('FLW-TW-35')!;
    expect(dead.isActive).toBe(false);
    expect(dead.demandDirection).toBe('none');
  });

  test('customer cadence and top SKUs; snapshots are versioned', async () => {
    const env = await synced();
    const v1 = await buildProfile(env.store, { clock: env.clock });
    expect(v1.customers.length).toBe(6);
    for (const c of v1.customers) {
      expect(c.orderCount).toBeGreaterThan(50);
      expect(c.cadenceDays).not.toBeNull();
      expect(c.topSkus.length).toBe(3);
    }
    env.clock.advance(60_000);
    const v2 = await buildProfile(env.store, { clock: env.clock });
    expect(v2.version).toBe(v1.version + 1);
    expect((await env.store.latestProfile())!.version).toBe(v2.version);
  });

  test('retail signal from Headset facts joins by SKU', async () => {
    const env = await synced();
    await ingestHeadsetTrends(
      env.store,
      [
        { sku: 'PRE-BD-1G', product_name: 'x', has_data: true, units_last_4w: 1200, units_prior_4w: 1000, units_wow_pct: 12.5, growth_3w_pct: 9, stores_carrying: 14, oos_days_last_3w: 2, weekly: [{ week_start: '2026-11-09', units: 300, revenue: 4500 }] },
        { sku: 'NOPE', has_data: false },
      ],
      { observedAt: '2026-11-19T00:00:00.000Z' },
    );
    const profile = await buildProfile(env.store, { clock: env.clock });
    const p = profile.products.find((x) => x.sku === 'PRE-BD-1G')!;
    expect(p.retail!.source).toBe('headset');
    expect(p.retail!.metrics.units_wow_pct).toBe(12.5);
    expect(p.retail!.metrics.stores_carrying).toBe(14);
    const block = await contextFor(env.store, { productIds: [p.productId] }, { clock: env.clock });
    expect(block.text).toContain('retail (headset)');
  });

  test('parseLeadTimeDays', () => {
    expect(parseLeadTimeDays('Standard lead time 7 days. Net 30.')).toBe(7);
    expect(parseLeadTimeDays('Lead-time: 10 business days')).toBe(10);
    expect(parseLeadTimeDays('LT 14d')).toBe(14);
    expect(parseLeadTimeDays('Net 30')).toBeNull();
  });
});
