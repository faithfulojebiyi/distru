/** The retail catalog must stay keyed by the same SKUs/names/customers as apps/distru-mock's seed. */
import { describe, expect, test } from 'bun:test';
import { createMockServer, LOW_STOCK_SKUS } from '@ops/distru-mock';
import { CATALOG, SCENARIO_SKUS, STORES } from '../src/app';

const distru = createMockServer({ now: '2026-11-19T12:00:00Z' });

describe('catalog mirrors distru-mock', () => {
  test('same SKUs and product names', () => {
    const products = [...distru.store.products.values()].map((p) => ({ sku: p.sku, name: p.name })).sort((a, b) => a.sku.localeCompare(b.sku));
    const ours = CATALOG.map((p) => ({ sku: p.sku, name: p.name })).sort((a, b) => a.sku.localeCompare(b.sku));
    expect(ours).toEqual(products);
  });

  test("distru-mock's dispensary customers are stores (plus extra market stores)", () => {
    const customers = [...distru.store.companies.values()].filter((c) => c.relationship === 'Customer').map((c) => c.name).sort();
    expect(STORES.filter((s) => s.distributor_customer).map((s) => s.name).sort()).toEqual(customers);
    expect(STORES.filter((s) => !s.distributor_customer).length).toBeGreaterThanOrEqual(3);
  });

  test('the "wholesale says fine" SKU is not below reorder point in distru-mock; the surging ones are', () => {
    expect(LOW_STOCK_SKUS).not.toContain(SCENARIO_SKUS.surging_wholesale_ok);
    expect(LOW_STOCK_SKUS).not.toContain(SCENARIO_SKUS.declining);
    for (const sku of SCENARIO_SKUS.surging) expect(LOW_STOCK_SKUS).toContain(sku);
  });
});
