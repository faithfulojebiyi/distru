/** AR read tools against the mock's seeded receivables (Harbor Greens is the worst account). */
import { beforeEach, describe, expect, test } from 'bun:test';
import { agentPrincipal, defineConnector, Registry } from '@ops/harness';
import { agingBucket, daysOverdue, distruConnector, DISTRU_RECEIVABLES_TOOLS, InvoicesOverdueOutput, InvoicesSearchOutput } from '../src';
import { planner, setup } from './setup';

const AS_OF = '2026-11-19';

/** The Distru connector with the AR tools registered (the shipped connector leaves them out for now). */
const withAr = defineConnector({ ...distruConnector, readTools: [...distruConnector.readTools, ...DISTRU_RECEIVABLES_TOOLS] });

let env: ReturnType<typeof make>;
const make = () => {
  const base = setup();
  const registry = Registry.fromConnectors([withAr]);
  return { ...base, registry, read: (tool: string, input: unknown = {}) => registry.runReadTool(base.ctx, planner, `distru.${tool}`, input) };
};
beforeEach(() => {
  env = make();
});

const customer = (name: string) => [...env.mock.store.companies.values()].find((c) => c.name === name)!;

describe('aging helpers', () => {
  test('days overdue in whole UTC days; buckets 1–30 / 31–60 / 61–90 / 90+', () => {
    const asOf = new Date('2026-11-19T23:00:00Z');
    expect(daysOverdue('2026-11-19T08:00:00Z', asOf)).toBe(0);
    expect(daysOverdue('2026-11-18T23:59:00Z', asOf)).toBe(1);
    expect(daysOverdue('2026-12-01T00:00:00Z', asOf)).toBeLessThan(0);
    expect([1, 30, 31, 60, 61, 90, 91].map(agingBucket)).toEqual(['d0_30', 'd0_30', 'd31_60', 'd31_60', 'd61_90', 'd61_90', 'd90_plus']);
  });
});

describe('distru_invoices_overdue', () => {
  test('groups overdue balances by customer, worst first: Harbor Greens with ~$18k over 60 days', async () => {
    const out = InvoicesOverdueOutput.parse(await env.read('invoices_overdue', { as_of: AS_OF }));
    expect(out.as_of).toBe(AS_OF);
    const worst = out.customers[0]!;
    expect(worst.customer.name).toBe('Harbor Greens');
    const over60 = worst.aging.d61_90 + worst.aging.d90_plus;
    expect(over60).toBeGreaterThan(17_000);
    expect(over60).toBeLessThan(20_000);
    expect(worst.oldest_days_overdue).toBeGreaterThan(60);
    expect(worst.partially_paid).toBeGreaterThan(0);
    // the worst account owes more than three times anyone else
    for (const c of out.customers.slice(1)) {
      expect(c.total_due * 3).toBeLessThan(worst.total_due);
      expect(c.aging.d61_90 + c.aging.d90_plus).toBe(0);
    }
    // a handful of overdue accounts, not everyone
    expect(out.customer_count).toBeGreaterThanOrEqual(3);
    expect(out.customer_count).toBeLessThan(6);
    const names = out.customers.map((c) => c.customer.name);
    expect(names).not.toContain('Green Leaf Dispensary');
    expect(names).not.toContain('Elevate Wellness');
    // totals add up; each listed invoice is overdue, oldest first
    const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
    expect(out.total_due).toBeCloseTo(sum(out.customers.map((c) => c.total_due)), 2);
    for (const c of out.customers) {
      expect(c.total_due).toBeCloseTo(sum(Object.values(c.aging)), 2);
      expect(c.invoices.every((i) => i.days_overdue >= 1 && i.remaining > 0)).toBe(true);
      expect(c.invoices.map((i) => i.days_overdue)).toEqual([...c.invoices.map((i) => i.days_overdue)].sort((a, b) => b - a));
      expect(c.invoices[0]!.days_overdue).toBe(c.oldest_days_overdue);
    }
    // no free text leaks through
    expect(JSON.stringify(out)).not.toContain('notes');
  });

  test('min_days_overdue and customer filter', async () => {
    const over60 = InvoicesOverdueOutput.parse(await env.read('invoices_overdue', { as_of: AS_OF, min_days_overdue: 61 }));
    expect(over60.customers.map((c) => c.customer.name)).toEqual(['Harbor Greens']);
    expect(over60.aging.d0_30 + over60.aging.d31_60).toBe(0);
    const canopy = customer('Canopy Club Sacramento');
    const one = InvoicesOverdueOutput.parse(await env.read('invoices_overdue', { as_of: AS_OF, customer_ids: [canopy.id], invoices_per_customer: 0 }));
    expect(one.customers).toHaveLength(1);
    expect(one.customers[0]!.aging.d31_60).toBeGreaterThan(0);
    expect(one.customers[0]!.invoices).toEqual([]);
    await expect(env.read('invoices_overdue', { min_days_overdue: 0 })).rejects.toThrow();
  });

  test('a payment recorded in Distru shows up on the next read', async () => {
    const harbor = customer('Harbor Greens');
    const before = InvoicesOverdueOutput.parse(await env.read('invoices_overdue', { as_of: AS_OF, customer_ids: [harbor.id] })).customers[0]!;
    const inv = before.invoices[0]!;
    const method = [...env.mock.store.paymentMethods.values()].find((m) => m.type === 'CASH')!;
    await env.ctx.connectors.distru.createInvoicePayment(inv.id, { payment_method_id: method.id, amount: inv.remaining, payment_datetime: '2026-11-19T15:00:00Z', description: 'Cash pickup' });
    const after = InvoicesOverdueOutput.parse(await env.read('invoices_overdue', { as_of: AS_OF, customer_ids: [harbor.id] })).customers[0]!;
    expect(after.invoice_count).toBe(before.invoice_count - 1);
    expect(after.total_due).toBeCloseTo(before.total_due - inv.remaining, 2);
  });
});

describe('distru_invoices_search', () => {
  test('by customer and status, newest first, with totals over every match', async () => {
    const harbor = customer('Harbor Greens');
    const out = InvoicesSearchOutput.parse(await env.read('invoices_search', { customer_ids: [harbor.id], statuses: ['PARTIALLY_PAID'], as_of: AS_OF, limit: 5 }));
    expect(out.count).toBeGreaterThan(0);
    expect(out.scan_complete).toBe(true);
    expect(out.invoices.every((i) => i.status === 'PARTIALLY_PAID' && i.customer?.id === harbor.id && i.paid > 0 && i.remaining > 0)).toBe(true);
    const dates = out.invoices.map((i) => i.invoice_date!);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(out.totals.remaining).toBeCloseTo(out.totals.total - out.totals.paid, 2);
  });

  test('overdue_only + min_remaining; invoice and order number lookups', async () => {
    const overdue = InvoicesSearchOutput.parse(await env.read('invoices_search', { overdue_only: true, as_of: AS_OF, limit: 100 }));
    expect(overdue.count).toBeGreaterThan(10);
    expect(overdue.invoices.every((i) => i.days_overdue >= 1 && i.remaining > 0)).toBe(true);
    const big = InvoicesSearchOutput.parse(await env.read('invoices_search', { overdue_only: true, min_remaining: 1500, as_of: AS_OF }));
    expect(big.invoices.every((i) => i.remaining >= 1500)).toBe(true);
    expect(big.count).toBeLessThan(overdue.count);

    const one = overdue.invoices[0]!;
    const byNumber = InvoicesSearchOutput.parse(await env.read('invoices_search', { invoice_number: one.invoice_number, as_of: AS_OF }));
    expect(byNumber.invoices.map((i) => i.id)).toContain(one.id);
    const byOrder = InvoicesSearchOutput.parse(await env.read('invoices_search', { order_numbers: [one.order_number!], as_of: AS_OF }));
    expect(byOrder.invoices.map((i) => i.id)).toEqual([one.id]);
    expect(byOrder.invoices[0]!.payment_terms).toMatch(/^Net (15|30)$/);
  });

  test('date ranges; paid-only statuses with overdue_only match nothing; a broad search reports an incomplete scan', async () => {
    const nov = InvoicesSearchOutput.parse(await env.read('invoices_search', { invoice_date_from: '2026-11-01', invoice_date_to: '2026-11-18', limit: 100 }));
    expect(nov.count).toBeGreaterThan(20);
    expect(nov.invoices.every((i) => i.invoice_date! >= '2026-11-01' && i.invoice_date! <= '2026-11-18')).toBe(true);
    const none = InvoicesSearchOutput.parse(await env.read('invoices_search', { statuses: ['FULLY_PAID'], overdue_only: true }));
    expect(none.count).toBe(0);
    const all = InvoicesSearchOutput.parse(await env.read('invoices_search', {}));
    expect(all.scan_complete).toBe(false);
    expect(all.invoices).toHaveLength(25);
  });

  test('registered: read tools for any principal with read scope; not in the shipped connector yet', async () => {
    const reader = agentPrincipal('ops-lead', 'Ops Lead');
    const names = env.registry.catalog(reader).map((t) => t.toolName);
    expect(names).toEqual(expect.arrayContaining(['distru_invoices_overdue', 'distru_invoices_search']));
    expect(env.registry.catalog(reader).filter((t) => t.toolName.startsWith('distru_invoices')).every((t) => t.kind === 'read')).toBe(true);
    expect(distruConnector.readTools.map((t) => t.name)).not.toContain('invoices_overdue');
  });
});
