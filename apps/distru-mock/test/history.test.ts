/**
 * The 12-month world: older sales and purchase orders (seed-year.ts) and accounts receivable
 * (receivables.ts). Everything added is deterministic, leaves the core seed's ids alone and keeps the
 * current at-risk sets (see locations.test.ts for the per-location matrix).
 */
import { describe, expect, test } from 'bun:test';
import { createMockServer, LOW_STOCK_SKUS } from '../src/app';
import { invoiceStatus, invoiceTotal, WORST_OVER_60_TARGET } from '../src/receivables';
import { seedStore, type ScenarioName } from '../src/seed';
import { CORE_HISTORY_DAYS, PRICE_INCREASE, seasonality } from '../src/seed-year';
import { inventoryVelocityReport, salesByProduct } from '../src/velocity';
import { DAY_MS, startOfUtcDay } from '../src/util';

const NOW = new Date('2026-11-19T12:00:00Z');
const TODAY = startOfUtcDay(NOW).getTime();
const AUTH = { Authorization: 'Bearer mock-token' };
const LOW = [...LOW_STOCK_SKUS].sort();
const daysAgo = (iso: string) => Math.floor((TODAY - startOfUtcDay(new Date(iso)).getTime()) / DAY_MS);

describe('12 months of sales', () => {
  const s = seedStore('default', NOW);
  const orders = [...s.orders.values()];

  test('orders span a year; the newest 120 days are the core seed (SO-1001 onwards), older ones count up to it', () => {
    const ages = orders.map((o) => daysAgo(o.order_datetime));
    expect(Math.max(...ages)).toBe(365);
    const older = orders.filter((o) => daysAgo(o.order_datetime) > CORE_HISTORY_DAYS);
    const core = orders.filter((o) => daysAgo(o.order_datetime) <= CORE_HISTORY_DAYS);
    expect(older.length).toBeGreaterThan(500);
    const num = (o: { order_number: string }) => Number(o.order_number.slice(3));
    expect(Math.max(...older.map(num))).toBe(1000);
    expect(Math.min(...core.map(num))).toBe(1001);
    // chronological numbering for the older months
    const sorted = [...older].sort((a, b) => num(a) - num(b));
    expect(sorted.every((o, i) => i === 0 || o.order_datetime >= sorted[i - 1]!.order_datetime)).toBe(true);
    expect(new Set(orders.map((o) => o.order_number)).size).toBe(orders.length);
  });

  test('seasonality: holiday bump and summer dip in the older months', () => {
    expect(seasonality(new Date('2025-12-20T00:00:00Z'))).toBeGreaterThan(1.1);
    expect(seasonality(new Date('2026-07-01T00:00:00Z'))).toBeLessThan(1);
    const unitsPerDay = (from: string, to: string) => {
      const a = Date.parse(from);
      const b = Date.parse(to);
      let units = 0;
      for (const o of orders) {
        const t = Date.parse(o.order_datetime);
        if (o.status !== 'CANCELED' && t >= a && t < b) units += o.items.reduce((n, i) => n + i.quantity, 0);
      }
      return units / ((b - a) / DAY_MS);
    };
    const december = unitsPerDay('2025-12-01T00:00:00Z', '2026-01-01T00:00:00Z');
    const june = unitsPerDay('2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z');
    const march = unitsPerDay('2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z');
    expect(december).toBeGreaterThan(march * 1.08);
    expect(june).toBeLessThan(march * 0.95);
  });

  test('the last 120 days of sales are exactly the core seed (velocity windows ≤ 120 days unchanged)', () => {
    // the core seed's sales only depend on its own PRNG: recompute them without the older months
    const sales = salesByProduct(s);
    const coreOnly = new Map<string, number>();
    for (const o of orders) {
      if (o.status === 'CANCELED' || daysAgo(o.order_datetime) > CORE_HISTORY_DAYS || daysAgo(o.order_datetime) < 1) continue;
      for (const i of o.items) coreOnly.set(i.product_id, (coreOnly.get(i.product_id) ?? 0) + i.quantity);
    }
    for (const [pid, units] of coreOnly) {
      const d = sales.get(pid)!.daily;
      let sum = 0;
      for (let k = 0; k < CORE_HISTORY_DAYS; k++) sum += d[k]!;
      expect(sum).toBe(units);
    }
    // core orders keep their numbers SO-1001… in the same order as before the older months existed
    const core = orders.filter((o) => Number(o.order_number.slice(3)) >= 1001);
    expect(core.every((o) => daysAgo(o.order_datetime) <= CORE_HISTORY_DAYS)).toBe(true);
  });

  test('current at-risk sets are unchanged: the canonical eight company-wide and per location; none in no-reorder-needed', () => {
    for (const scenario of ['default', 'clean', 'failed-lab-test', 'prompt-injection'] as ScenarioName[]) {
      const st = seedStore(scenario, NOW);
      for (const lead of [7, 14, 21]) {
        expect(inventoryVelocityReport(st, { lead_time_days: lead, below_reorder_point: true }).data.map((r) => r.sku).sort()).toEqual(LOW);
      }
      const [, la, sac] = st.ownLocationIds as [string, string, string];
      for (const loc of [la, sac]) expect(inventoryVelocityReport(st, { lead_time_days: 14, below_reorder_point: true, location_ids: [loc] }).data.map((r) => r.sku).sort()).toEqual(LOW);
    }
    const none = seedStore('no-reorder-needed', NOW);
    for (const loc of [undefined, ...none.ownLocationIds]) {
      for (const lead of [7, 14, 21]) expect(inventoryVelocityReport(none, { lead_time_days: lead, below_reorder_point: true, location_ids: loc ? [loc] : undefined }).data).toEqual([]);
    }
  });

  test('the 365-day columns now carry a year of sales', () => {
    const row = inventoryVelocityReport(s, { lead_time_days: 14 }).data.find((r) => r.sku === 'PRE-BD-1G')!;
    expect(Number(row.quantity_sold_365)).toBeGreaterThan(Number(row.quantity_sold_120) * 2.5);
  });
});

describe('a year of purchase orders per vendor', () => {
  const vendorsOf = (st: ReturnType<typeof seedStore>) => [...st.companies.values()].filter((c) => c.relationship === 'Vendor');
  const completed = (st: ReturnType<typeof seedStore>, vendorId: string) =>
    [...st.purchases.values()].filter((p) => p.company_id === vendorId && p.status === 'COMPLETED').sort((a, b) => (a.order_datetime! < b.order_datetime! ? -1 : 1));
  const leadOf = (p: { order_datetime: string | null; updated_datetime: string }) => Math.round((Date.parse(p.updated_datetime) - Date.parse(p.order_datetime!)) / DAY_MS);

  test('8–12 completed POs per vendor across the year, numbered below PO-501 oldest first', () => {
    const st = seedStore('default', NOW);
    for (const v of vendorsOf(st)) {
      const pos = completed(st, v.id);
      expect(pos.length).toBeGreaterThanOrEqual(8);
      expect(pos.length).toBeLessThanOrEqual(12);
      expect(Math.max(...pos.map((p) => daysAgo(p.order_datetime!)))).toBeGreaterThan(300);
    }
    const older = [...st.purchases.values()].filter((p) => Number(p.purchase_number.slice(3)) <= 500);
    expect(older.length).toBeGreaterThan(30);
    const sorted = [...older].sort((a, b) => Number(a.purchase_number.slice(3)) - Number(b.purchase_number.slice(3)));
    expect(sorted.at(-1)!.purchase_number).toBe('PO-500');
    expect(sorted.every((p, i) => i === 0 || p.order_datetime! >= sorted[i - 1]!.order_datetime!)).toBe(true);
  });

  test('default: every receipt on time and complete (the profile tests in @ops/context rely on it)', () => {
    const st = seedStore('default', NOW);
    for (const v of vendorsOf(st)) {
      for (const p of completed(st, v.id)) {
        expect(leadOf(p)).toBe(v.lead_time_days);
        expect(p.items.every((i) => i.received_quantity === i.quantity)).toBe(true);
      }
    }
  });

  test('one price increase per vendor, on its most recent completed PO', () => {
    const st = seedStore('default', NOW);
    const keyOf: Record<string, keyof typeof PRICE_INCREASE> = {
      'Humboldt Heritage Farms': 'HHF',
      'Emerald Triangle Growers': 'ETG',
      'Sierra Extracts Co.': 'SEC',
      'Golden State Edibles': 'GSE',
      'Coastal Cloud Vapes': 'CCV',
      'Mojave Pre-Roll Co.': 'MPR',
    };
    for (const v of vendorsOf(st)) {
      const pos = completed(st, v.id);
      const [prev, last] = pos.slice(-2) as [(typeof pos)[0], (typeof pos)[0]];
      const priceOf = (p: typeof prev) => new Map(p.items.map((i) => [i.product_id ?? st.batches.get(i.batch_id!)!.product_id, i.price]));
      const before = priceOf(prev);
      const inc = PRICE_INCREASE[keyOf[v.name]!];
      for (const [pid, price] of priceOf(last)) expect(price / before.get(pid)!).toBeCloseTo(1 + inc, 2);
      // older POs stay at the old price level (within the usual ±4 % noise)
      for (const p of pos.slice(0, -1)) for (const i of p.items) {
        const product = st.products.get(i.product_id ?? st.batches.get(i.batch_id!)!.product_id)!;
        expect(i.price / product.unit_cost).toBeLessThan(1.045);
      }
    }
  });

  test('poVariation: a few late receipts and short shipments per vendor; ids and the median lead time unchanged', () => {
    const plain = seedStore('default', NOW);
    const varied = seedStore('default', NOW, { poVariation: true });
    expect([...varied.purchases.keys()]).toEqual([...plain.purchases.keys()]);
    expect([...varied.orders.keys()]).toEqual([...plain.orders.keys()]);
    for (const v of vendorsOf(varied)) {
      const pos = completed(varied, v.id);
      const leads = pos.map(leadOf).sort((a, b) => a - b);
      const late = leads.filter((d) => d > v.lead_time_days + 1).length;
      const short = pos.filter((p) => p.items.some((i) => i.received_quantity < i.quantity)).length;
      expect(late).toBeGreaterThanOrEqual(1);
      expect(late).toBeLessThanOrEqual(3);
      expect(short).toBeGreaterThanOrEqual(1);
      expect(short).toBeLessThanOrEqual(2);
      expect(leads[Math.floor(leads.length / 2)]).toBe(v.lead_time_days);
      // only the older POs vary; the core seed's three are untouched
      for (const p of pos.filter((x) => Number(x.purchase_number.slice(3)) > 500)) expect(leadOf(p)).toBe(v.lead_time_days);
    }
    // the at-risk sets do not depend on it
    expect(inventoryVelocityReport(varied, { lead_time_days: 14, below_reorder_point: true }).data.map((r) => r.sku).sort()).toEqual(LOW);
  });
});

describe('accounts receivable', () => {
  const s = seedStore('default', NOW);
  const name = (id: string) => s.companies.get(id)!.name;
  const aging = () => {
    const by = new Map<string, { overdue: number; over60: number; b31: number; oldest: number; open: number }>();
    for (const inv of s.invoices.values()) {
      const total = invoiceTotal(s, inv);
      const remaining = Math.round((total - s.invoicePaid(inv.id)) * 100) / 100;
      const a = by.get(name(inv.company_id)) ?? { overdue: 0, over60: 0, b31: 0, oldest: 0, open: 0 };
      if (remaining > 0) {
        a.open += remaining;
        const dpd = daysAgo(inv.due_datetime);
        if (dpd > 0) a.overdue += remaining;
        if (dpd > 60) a.over60 += remaining;
        else if (dpd > 30) a.b31 += remaining;
        if (dpd > 0) a.oldest = Math.max(a.oldest, dpd);
      }
      by.set(name(inv.company_id), a);
    }
    return by;
  };

  test('one invoice per completed or delivered order, on the customer’s Net 15 / Net 30 terms', () => {
    const billed = [...s.orders.values()].filter((o) => o.status === 'COMPLETED' || o.status === 'DELIVERED');
    expect(s.invoices.size).toBe(billed.length);
    for (const inv of s.invoices.values()) {
      const days = Math.round((Date.parse(inv.due_datetime) - Date.parse(inv.invoice_datetime)) / DAY_MS);
      expect(days).toBe(inv.payment_term_name === 'Net 15' ? 15 : 30);
    }
    const terms = new Set([...s.invoices.values()].map((i) => i.payment_term_name));
    expect([...terms].sort()).toEqual(['Net 15', 'Net 30']);
    expect(new Set([...s.invoices.values()].map((i) => i.invoice_number)).size).toBe(s.invoices.size);
    // all six dispensaries are billed across the whole year
    const customers = new Set([...s.invoices.values()].map((i) => i.company_id));
    expect(customers.size).toBe(6);
    expect(Math.max(...[...s.invoices.values()].map((i) => daysAgo(i.invoice_datetime)))).toBeGreaterThan(350);
  });

  test('statuses: mostly paid, some partly paid, current ones open; paid amounts never exceed totals', () => {
    const counts: Record<string, number> = {};
    for (const inv of s.invoices.values()) {
      const total = invoiceTotal(s, inv);
      const paid = s.invoicePaid(inv.id);
      expect(paid).toBeLessThanOrEqual(total + 0.005);
      const st = invoiceStatus(total, paid);
      counts[st] = (counts[st] ?? 0) + 1;
    }
    expect(counts.FULLY_PAID!).toBeGreaterThan(s.invoices.size * 0.8);
    expect(counts.PARTIALLY_PAID!).toBeGreaterThanOrEqual(3);
    expect(counts.NOT_PAID!).toBeGreaterThan(50);
    expect(counts.OVER_PAID ?? 0).toBe(0);
  });

  test('Harbor Greens is clearly the worst account: ~$18k more than 60 days past due', () => {
    const by = aging();
    const harbor = by.get('Harbor Greens')!;
    expect(harbor.over60).toBeGreaterThan(WORST_OVER_60_TARGET - 1000);
    expect(harbor.over60).toBeLessThan(WORST_OVER_60_TARGET + 2000);
    for (const [n, a] of by) {
      if (n === 'Harbor Greens') continue;
      expect(a.over60).toBe(0);
      expect(a.overdue).toBeLessThan(harbor.overdue / 3);
    }
    // a handful of other overdue accounts
    expect(by.get('Canopy Club Sacramento')!.b31).toBeGreaterThan(0);
    expect(by.get('The Herbal Cure')!.overdue).toBeGreaterThan(0);
    expect(by.get('Green Leaf Dispensary')!.overdue).toBe(0);
    expect(by.get('Elevate Wellness')!.overdue).toBe(0);
  });

  test('identical across scenarios (orders are)', () => {
    const other = seedStore('no-reorder-needed', NOW);
    expect([...other.invoices.keys()]).toEqual([...s.invoices.keys()]);
    expect([...other.payments.keys()]).toEqual([...s.payments.keys()]);
  });
});

describe('REST: invoices, payments, payment methods', () => {
  const mock = createMockServer({ now: NOW.toISOString(), webhookRetryDelaysMs: [] });
  const req = (path: string, body?: unknown) =>
    mock.app.request(`http://mock.test/public/v1${path}`, body === undefined ? { headers: AUTH } : { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = async (r: Response) => (await r.json()) as Record<string, unknown> & { data: never; next_page: string | null };
  const harbor = [...mock.store.companies.values()].find((c) => c.name === 'Harbor Greens')!;

  test('list: newest first, filters by customer, status, due date and remaining amount', async () => {
    const asOf = new Date(TODAY - 60 * DAY_MS).toISOString();
    let url: string | null = `/invoices?company_ids[]=${harbor.id}&statuses[]=NOT_PAID&statuses[]=PARTIALLY_PAID&due_datetime=,${asOf}&remaining_amount=0.01,`;
    let owed = 0;
    let last = '9999';
    let n = 0;
    while (url) {
      const page: { data: { invoice_datetime: string; remaining_amount: string; status: string; company: { id: string } }[]; next_page: string | null } = await json(await req(url));
      for (const inv of page.data) {
        expect(inv.invoice_datetime <= last).toBe(true);
        last = inv.invoice_datetime;
        expect(inv.company.id).toBe(harbor.id);
        expect(['NOT_PAID', 'PARTIALLY_PAID']).toContain(inv.status);
        owed += Number(inv.remaining_amount);
        n++;
      }
      url = page.next_page ? page.next_page.replace('http://mock.test/public/v1', '') : null;
    }
    expect(n).toBeGreaterThan(5);
    expect(owed).toBeGreaterThan(WORST_OVER_60_TARGET - 1000);
    const bad = await req('/invoices?statuses[]=LATE');
    expect(bad.status).toBe(400);
    expect((await req('/invoices?total=,')).status).toBe(400);
  });

  test('orders link their invoice; the invoice embeds the order lines and its payments', async () => {
    const inv = [...mock.store.invoices.values()].find((i) => mock.store.paymentsOf(i.id).length === 2) ?? [...mock.store.invoices.values()].find((i) => mock.store.paymentsOf(i.id).length)!;
    const order = (await json(await req(`/orders/${inv.order_id}`))).data as { invoices: { id: string; status: string }[]; payment_term_name: string };
    expect(order.invoices.map((i) => i.id)).toEqual([inv.id]);
    expect(order.payment_term_name).toBe(inv.payment_term_name!);
    const got = (await json(await req(`/invoices/${inv.id}`))).data as { items: { order_item: { id: string } }[]; payments: { amount: string }[]; paid_amount: string; total: string; order: { id: string } };
    expect(got.order.id).toBe(inv.order_id);
    expect(got.items.length).toBe(mock.store.orders.get(inv.order_id)!.items.length);
    expect(got.payments.reduce((a, p) => a + Number(p.amount), 0)).toBeCloseTo(Number(got.paid_amount), 2);
    const pays = (await json(await req(`/payments?invoice_ids[]=${inv.id}`))).data as { invoice: { id: string } }[];
    expect(pays.length).toBe(mock.store.paymentsOf(inv.id).length);
    expect(pays.every((p) => p.invoice.id === inv.id)).toBe(true);
  });

  test('POST /invoices/{id}/payments: partial, then capped with a credit; fully paid and voided are refused', async () => {
    const methods = (await json(await req('/payment-methods'))).data as { id: string; active: boolean; type: string }[];
    expect(methods.map((m) => m.type).sort()).toEqual(['BANK_TRANSFER', 'CASH', 'CHECK', 'CREDIT_CARD']);
    const ach = methods.find((m) => m.type === 'BANK_TRANSFER')!;
    const card = methods.find((m) => m.type === 'CREDIT_CARD')!;
    expect(card.active).toBe(false);
    const inv = [...mock.store.invoices.values()].find((i) => i.company_id === harbor.id && mock.store.invoicePaid(i.id) === 0)!;
    const total = invoiceTotal(mock.store, inv);

    const part = await req(`/invoices/${inv.id}/payments`, { payment_method_id: ach.id, amount: 100, payment_datetime: '2026-11-19T10:00:00Z', description: 'Partial' });
    expect(part.status).toBe(200);
    const p1 = (await json(part)).data as { amount: string; invoice: { status: string }; overpayment_credits: unknown[]; quickbooks_sync_enqueued: boolean };
    expect(p1).toMatchObject({ amount: '100', invoice: { status: 'PARTIALLY_PAID' }, overpayment_credits: [], quickbooks_sync_enqueued: false });

    const rest = await req(`/invoices/${inv.id}/payments`, { payment_method_id: ach.id, amount: total, payment_datetime: '2026-11-19T11:00:00Z', description: 'Rest' });
    const p2 = (await json(rest)).data as { amount: string; overpayment_credits: { amount: string; source: string }[] };
    expect(Number(p2.amount)).toBeCloseTo(total - 100, 2);
    expect(p2.overpayment_credits).toEqual([expect.objectContaining({ amount: '100.00', source: 'INVOICE_PAYMENT' })]);
    const after = (await json(await req(`/invoices/${inv.id}`))).data as { status: string; remaining_amount: string };
    expect(after).toMatchObject({ status: 'FULLY_PAID', remaining_amount: '0.00' });

    const again = await req(`/invoices/${inv.id}/payments`, { payment_method_id: ach.id, amount: 1, payment_datetime: '2026-11-19T12:00:00Z', description: 'x' });
    expect(again.status).toBe(400);
    const other = [...mock.store.invoices.values()].find((i) => mock.store.invoicePaid(i.id) === 0)!;
    expect((await req(`/invoices/${other.id}/payments`, { payment_method_id: card.id, amount: 1, payment_datetime: '2026-11-19T12:00:00Z', description: 'x' })).status).toBe(400);
    expect((await req(`/invoices/${other.id}/payments`, { payment_method_id: ach.id, amount: 0, payment_datetime: 'nope' })).status).toBe(400);
    mock.store.invoices.get(other.id)!.voided_datetime = '2026-11-18T00:00:00Z';
    expect((await req(`/invoices/${other.id}/payments`, { payment_method_id: ach.id, amount: 1, payment_datetime: '2026-11-19T12:00:00Z', description: 'x' })).status).toBe(400);
    expect((await req('/invoices/nope/payments', { payment_method_id: ach.id, amount: 1, payment_datetime: '2026-11-19T12:00:00Z', description: 'x' })).status).toBe(404);

    // the payment is in the activity feed
    const act = (await json(await req('/activity'))).data as { records: { type: string; id: string }[] }[];
    expect(act.some((a) => a.records.some((r) => r.type === 'INVOICE' && r.id === inv.id))).toBe(true);
  });

  test('state counts and reset keep the AR world; po_variation can be switched on reset', async () => {
    const state = (await (await mock.app.request('/__mock/state')).json()) as { counts: { invoices: number; payments: number }; po_variation: boolean };
    expect(state.counts.invoices).toBeGreaterThan(1000);
    expect(state.po_variation).toBe(false);
    const r = await mock.app.request('/__mock/reset', { method: 'POST', body: JSON.stringify({ po_variation: true }), headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(200);
    expect(mock.poVariation).toBe(true);
    const bad = await mock.app.request('/__mock/reset', { method: 'POST', body: JSON.stringify({ po_variation: 'yes' }), headers: { 'content-type': 'application/json' } });
    expect(bad.status).toBe(400);
  });
});
