import { describe, expect, test } from 'bun:test';
import { blendDemandSignal, classifyOosTrend, classifyRetailSignal } from '../src';

const base = { wholesaleAvgDaily: 4, retailOosTrend: 'flat' as const };

describe('blendDemandSignal', () => {
  test('no retail signal → wholesale only, unchanged numbers', () => {
    const r = blendDemandSignal({ ...base, wholesaleDaysOfSupply: 60, retailGrowth3w: null, retailOosTrend: null });
    expect(r).toMatchObject({ adjustedDaysOfSupply: 60, adjustedAvgDaily: 4, demandFactor: 1, recommendation: 'ok' });
    expect(r.reasons[0]).toContain('no retail signal');
  });

  test('flat retail (|g| < 10%) is noise', () => {
    const r = blendDemandSignal({ ...base, wholesaleDaysOfSupply: 30, retailGrowth3w: 9.9 });
    expect(r.demandFactor).toBe(1);
    expect(r.adjustedDaysOfSupply).toBe(30);
    expect(r.recommendation).toBe('watch'); // 30 ≤ 2 × 21
  });

  test('surge shrinks days of supply; deep stock + surge → watch, never ok', () => {
    const r = blendDemandSignal({ ...base, wholesaleDaysOfSupply: 68.4, retailGrowth3w: 52 });
    expect(r.demandFactor).toBe(1.52);
    expect(r.adjustedDaysOfSupply).toBe(45);
    expect(r.adjustedAvgDaily).toBe(6.08);
    expect(r.recommendation).toBe('watch');
    expect(r.reasons.join(' ')).toContain('retail demand leads wholesale');
  });

  test('surge pushes a borderline SKU into reorder_now', () => {
    expect(blendDemandSignal({ ...base, wholesaleDaysOfSupply: 28, retailGrowth3w: 45 }).recommendation).toBe('reorder_now'); // 19.3 ≤ 21
    expect(blendDemandSignal({ ...base, wholesaleDaysOfSupply: 28, retailGrowth3w: null }).recommendation).toBe('watch');
  });

  test('declines count half and can relax a borderline SKU', () => {
    const r = blendDemandSignal({ ...base, wholesaleDaysOfSupply: 20, retailGrowth3w: -30 });
    expect(r.demandFactor).toBe(0.85);
    expect(r.adjustedDaysOfSupply).toBe(23.5);
    expect(r.recommendation).toBe('watch');
  });

  test('wholesale DoS within lead time → reorder_now even when retail is declining', () => {
    const r = blendDemandSignal({ ...base, wholesaleDaysOfSupply: 10, retailGrowth3w: -50 });
    expect(r.recommendation).toBe('reorder_now');
    expect(r.adjustedDaysOfSupply).toBe(13.3);
  });

  test('growth is clamped to [-50, +150]', () => {
    expect(blendDemandSignal({ ...base, wholesaleDaysOfSupply: 100, retailGrowth3w: 900 }).demandFactor).toBe(2.5);
    expect(blendDemandSignal({ ...base, wholesaleDaysOfSupply: 100, retailGrowth3w: -95 }).demandFactor).toBe(0.75);
  });

  test('rising stock-outs add +15% and force at least watch', () => {
    const r = blendDemandSignal({ ...base, wholesaleDaysOfSupply: 100, retailGrowth3w: 0, retailOosTrend: 'rising' });
    expect(r.demandFactor).toBe(1.15);
    expect(r.adjustedDaysOfSupply).toBe(87);
    expect(r.recommendation).toBe('watch');
  });

  test('no wholesale demand: null DoS or zero velocity', () => {
    expect(blendDemandSignal({ ...base, wholesaleDaysOfSupply: null, wholesaleAvgDaily: 0, retailGrowth3w: null })).toMatchObject({ adjustedDaysOfSupply: null, recommendation: 'ok' });
    expect(blendDemandSignal({ ...base, wholesaleDaysOfSupply: 365, wholesaleAvgDaily: 0, retailGrowth3w: 60 })).toMatchObject({ adjustedDaysOfSupply: null, recommendation: 'watch' });
  });

  test('custom lead time / safety; zero stock; NaN growth treated as no signal', () => {
    expect(blendDemandSignal({ ...base, wholesaleDaysOfSupply: 40, retailGrowth3w: 0, leadTimeDays: 30, safetyDays: 14 }).recommendation).toBe('reorder_now');
    expect(blendDemandSignal({ ...base, wholesaleDaysOfSupply: 0, retailGrowth3w: 20 })).toMatchObject({ adjustedDaysOfSupply: 0, recommendation: 'reorder_now' });
    expect(blendDemandSignal({ ...base, wholesaleDaysOfSupply: 50, retailGrowth3w: Number.NaN }).demandFactor).toBe(1);
  });
});

describe('classifiers', () => {
  test('retail signal thresholds', () => {
    const t = (g: number | null, units = 100, has_data = true) => classifyRetailSignal({ has_data, growth_3w_pct: g, units_last_4w: units });
    expect([t(30), t(29.9), t(10), t(9.9), t(-9.9), t(-10)]).toEqual(['surging', 'rising', 'rising', 'flat', 'flat', 'declining']);
    expect([t(null), t(50, 7), t(50, 100, false)]).toEqual(['no_data', 'no_data', 'no_data']);
  });

  test('oos trend needs a real change, scaled by stores', () => {
    const o = (last: number, prior: number, stores = 10) => classifyOosTrend({ oos_days_last_3w: last, oos_days_prior_3w: prior, stores_carrying: stores });
    expect(o(90, 30)).toBe('rising');
    expect(o(6, 1, 8)).toBe('flat'); // noise across 8 stores
    expect(o(5, 1, 2)).toBe('rising');
    expect(o(1, 20)).toBe('falling');
    expect(o(0, 0)).toBe('flat');
  });
});
