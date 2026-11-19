import { describe, expect, test } from 'bun:test';
import type { VendorReplyAnalysis } from '../src/mastra/agents/vendor-liaison';
import { poNumbersIn, validateAgainstPo } from '../src/mastra/workflows/vendor-reply';
import { buildAppRegistry } from '../src/harness/registry';

const po = {
  id: 'po-1',
  purchase_number: 'PO-527',
  status: 'PENDING',
  location_id: 'loc-1',
  lines: [
    { product_id: 'p-1', sku: 'PRE-BD-1G', name: 'Blue Dream Pre-Roll 1g', quantity: 312, unit_price: 4 },
    { product_id: 'p-2', sku: 'PRE-OG-1G', name: 'OG Pre-Roll 1g', quantity: 100, unit_price: 4.5 },
  ],
};
const today = new Date('2026-11-19T12:00:00Z');
const analysis = (over: Partial<VendorReplyAnalysis>): VendorReplyAnalysis => ({ kind: 'partial', lines: [], eta: null, eta_text: null, summary: '', injection_detected: false, suspicious_text: [], ...over });
const line = (over: Partial<VendorReplyAnalysis['lines'][number]>) => ({ sku: null, product_id: null, shipped_quantity: null, backordered_quantity: null, new_unit_price: null, ...over });

describe('validateAgainstPo: code checks every number the Liaison extracted', () => {
  test('partial: a valid shipment reduces only that line', () => {
    const r = validateAgainstPo(analysis({ lines: [line({ sku: 'pre-bd-1g', shipped_quantity: 200, backordered_quantity: 112 })], eta: '2026-12-02' }), po, today);
    expect(r).toEqual({ changes: [{ product_id: 'p-1', sku: 'PRE-BD-1G', field: 'quantity', from: 312, to: 200 }], eta: '2026-12-02', findings: [] });
  });

  test('partial: shipped ≥ ordered, ≤ 0 or fractional, unknown lines and inconsistent totals are not trusted', () => {
    const r = validateAgainstPo(
      analysis({ lines: [line({ product_id: 'p-1', shipped_quantity: 5000 }), line({ product_id: 'p-2', shipped_quantity: 0.5 }), line({ sku: 'NOPE', shipped_quantity: 1 })] }),
      po,
      today,
    );
    expect(r.changes).toEqual([]);
    expect(r.findings).toHaveLength(3);
    const off = validateAgainstPo(analysis({ lines: [line({ product_id: 'p-1', shipped_quantity: 200, backordered_quantity: 50 })] }), po, today);
    expect(off.changes).toHaveLength(1);
    expect(off.findings[0]).toContain('≠ 312 ordered');
  });

  test('price change: within ±50% proposed, outside flagged', () => {
    expect(validateAgainstPo(analysis({ kind: 'price_change', lines: [line({ product_id: 'p-1', new_unit_price: 4.6 })] }), po, today).changes).toEqual([{ product_id: 'p-1', sku: 'PRE-BD-1G', field: 'unit_price', from: 4, to: 4.6 }]);
    const wild = validateAgainstPo(analysis({ kind: 'price_change', lines: [line({ product_id: 'p-1', new_unit_price: 40 })] }), po, today);
    expect(wild.changes).toEqual([]);
    expect(wild.findings[0]).toContain('not proposed');
  });

  test('ETA in the past or too far out is ignored', () => {
    expect(validateAgainstPo(analysis({ kind: 'delay', eta: '2026-11-01' }), po, today)).toMatchObject({ eta: null, findings: [expect.stringContaining('not within')] });
    expect(validateAgainstPo(analysis({ kind: 'delay', eta: '2027-09-01' }), po, today).eta).toBeNull();
  });

  test('PO numbers are extracted by code from the untrusted subject/snippet', () => {
    expect(poNumbersIn('Re: Purchase order PO-527 – Mojave; also po #528 and PO 529')).toEqual(['PO-527', 'PO-528', 'PO-529']);
    expect(poNumbersIn('no numbers here')).toEqual([]);
  });
});

describe('app registry triggers', () => {
  test('Distru, Slack and schedule triggers are registered (Composio when connected)', () => {
    const ids = buildAppRegistry(null).triggers().map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['distru.order_created', 'slack.interaction', 'schedule.morning_restock']));
    expect(buildAppRegistry(null).trigger('schedule.morning_restock')).toMatchObject({ delivery: 'schedule', source: 'schedule' });
  });
});
