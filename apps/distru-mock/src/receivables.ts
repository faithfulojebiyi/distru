/**
 * Accounts receivable: one invoice per billed sales order (COMPLETED / DELIVERED), dated on the order
 * date, due after the customer's payment term, and payments that follow each customer's habits. Drawn
 * from its own PRNG after everything else, so no other seeded id moves.
 *
 * Customers (by name):
 * - Green Leaf Dispensary, Elevate Wellness: Net 30, pay on time or early (ACH).
 * - Sunset Cannabis Collective, The Herbal Cure: Net 15, a few days either side of the due date;
 *   The Herbal Cure has one invoice ~3 weeks overdue that was only partly paid.
 * - Canopy Club Sacramento: Net 30, pays up to 10 days late; two invoices 31–60 days overdue.
 * - Harbor Greens: Net 30 and clearly the worst account: ~$18k more than 60 days overdue, partial
 *   payments on the 31–60 day invoices, nothing on the current ones (pays cash, late).
 *
 * `recordInvoicePayment` is the write behind POST /invoices/{id}/payments (amount capped at the
 * remaining balance; the excess becomes a customer credit, as Distru does).
 */
import { rng, type Rng, type Store } from './store';
import type { ApiErrorItem } from './upsert';
import type { InvoiceRec, InvoiceStatus, OrderRec, PaymentMethodRec, PaymentRec } from './types';
import { DAY_MS, startOfUtcDay } from './util';

type Habit = 'on_time' | 'early' | 'slight' | 'slow' | 'worst' | 'partial_once';

export const CUSTOMER_TERMS: Record<string, { term: 'Net 15' | 'Net 30'; days: number; method: 'ach' | 'check' | 'cash'; habit: Habit; delay: [number, number] }> = {
  'Green Leaf Dispensary': { term: 'Net 30', days: 30, method: 'ach', habit: 'on_time', delay: [-5, 2] },
  'Sunset Cannabis Collective': { term: 'Net 15', days: 15, method: 'check', habit: 'slight', delay: [-2, 6] },
  'Elevate Wellness': { term: 'Net 30', days: 30, method: 'ach', habit: 'early', delay: [-8, 0] },
  'Canopy Club Sacramento': { term: 'Net 30', days: 30, method: 'check', habit: 'slow', delay: [0, 10] },
  'Harbor Greens': { term: 'Net 30', days: 30, method: 'cash', habit: 'worst', delay: [18, 35] },
  'The Herbal Cure': { term: 'Net 15', days: 15, method: 'cash', habit: 'partial_once', delay: [-3, 8] },
};

/** The worst account's balance more than 60 days past due (approximately; the seed lands within ~$1k). */
export const WORST_OVER_60_TARGET = 18_000;

const r2 = (n: number) => Math.round(n * 100) / 100;

export function orderTotal(o: OrderRec): number {
  const sub = o.items.reduce((a, i) => a + i.quantity * i.price, 0);
  const charges = o.charges.reduce((a, c) => {
    const raw = c.unit_type === 'PERCENT' ? (sub * (c.percent ?? 0)) / 100 : (c.price ?? 0);
    return a + (c.type === 'DISCOUNT' ? -Math.abs(raw) : Math.abs(raw));
  }, 0);
  return r2(sub + charges);
}

export function invoiceTotal(s: Store, inv: InvoiceRec): number {
  const o = s.orders.get(inv.order_id);
  return o ? orderTotal(o) : 0;
}

export function invoiceStatus(total: number, paid: number): InvoiceStatus {
  if (paid <= 0) return 'NOT_PAID';
  if (paid + 0.005 < total) return 'PARTIALLY_PAID';
  return paid > total + 0.005 ? 'OVER_PAID' : 'FULLY_PAID';
}

export function termFor(s: Store, companyId: string) {
  const name = s.companies.get(companyId)?.name ?? '';
  return CUSTOMER_TERMS[name] ?? { term: 'Net 30' as const, days: 30, method: 'check' as const, habit: 'on_time' as Habit, delay: [0, 5] as [number, number] };
}

export function addInvoice(s: Store, inv: InvoiceRec): void {
  s.invoices.set(inv.id, inv);
  s.invoiceIdsByOrder.set(inv.order_id, [...(s.invoiceIdsByOrder.get(inv.order_id) ?? []), inv.id]);
}

export function seedReceivables(s: Store, opts: { ownerId: string | null; creatorId: string | null }): void {
  const r: Rng = rng(20261203);
  const now = s.now.getTime();
  const today = startOfUtcDay(s.now).getTime();
  const created = new Date(today - 400 * DAY_MS + 9 * 3_600_000).toISOString();

  const methods: Record<'ach' | 'check' | 'cash', PaymentMethodRec> = {
    ach: { id: r.uuid(), name: 'ACH', type: 'BANK_TRANSFER', active: true, inserted_datetime: created, updated_datetime: created },
    check: { id: r.uuid(), name: 'Check', type: 'CHECK', active: true, inserted_datetime: created, updated_datetime: created },
    cash: { id: r.uuid(), name: 'Cash', type: 'CASH', active: true, inserted_datetime: created, updated_datetime: created },
  };
  const card: PaymentMethodRec = { id: r.uuid(), name: 'Credit Card', type: 'CREDIT_CARD', active: false, inserted_datetime: created, updated_datetime: created };
  for (const m of [...Object.values(methods), card]) s.paymentMethods.set(m.id, m);

  // ── invoices, oldest first ──────────────────────────────────────────────────────────────────
  const billed = [...s.orders.values()]
    .filter((o) => o.status === 'COMPLETED' || o.status === 'DELIVERED')
    .sort((a, b) => (a.order_datetime === b.order_datetime ? a.id.localeCompare(b.id) : a.order_datetime < b.order_datetime ? -1 : 1));
  const invoices: InvoiceRec[] = [];
  for (const o of billed) {
    const t = termFor(s, o.company_id);
    const inv: InvoiceRec = {
      id: r.uuid(),
      invoice_number: `INV-${++s.counters.invoice}`,
      order_id: o.id,
      company_id: o.company_id,
      billing_location_id: o.billing_location_id,
      invoice_datetime: o.order_datetime,
      due_datetime: new Date(Date.parse(o.order_datetime) + t.days * DAY_MS).toISOString(),
      payment_term_name: t.term,
      items: o.items.map((i) => ({ id: r.uuid(), order_item_id: i.id, quantity: i.quantity, inserted_datetime: o.order_datetime })),
      charges: o.charges.map((c) => ({ ...c })),
      owner_id: opts.ownerId,
      creator_id: opts.creatorId,
      internal_notes: null,
      external_notes: null,
      voided_datetime: null,
      inserted_datetime: o.order_datetime,
      updated_datetime: o.order_datetime,
    };
    addInvoice(s, inv);
    invoices.push(inv);
  }

  // ── payments ────────────────────────────────────────────────────────────────────────────────
  const pending: PaymentRec[] = [];
  const pay = (inv: InvoiceRec, amount: number, atMs: number, method: PaymentMethodRec, description: string | null = null) => {
    const at = new Date(Math.min(atMs, now - 3_600_000)).toISOString();
    pending.push({
      id: r.uuid(),
      payment_number: '',
      invoice_id: inv.id,
      company_id: inv.company_id,
      amount: r2(amount),
      payment_method_id: method.id,
      payment_datetime: at,
      description,
      status: 'POSTED',
      quickbooks_deposit_account_id: null,
      quickbooks_deposit_account_name: null,
      overpayment_credit: null,
      inserted_datetime: at,
      updated_datetime: at,
    });
  };
  const dayAt = (base: number, days: number) => startOfUtcDay(new Date(base + days * DAY_MS)).getTime() + 17 * 3_600_000;
  const dpdOf = (inv: InvoiceRec) => Math.floor((today - startOfUtcDay(new Date(inv.due_datetime)).getTime()) / DAY_MS);

  const byCustomer = new Map<string, InvoiceRec[]>();
  for (const inv of invoices) byCustomer.set(inv.company_id, [...(byCustomer.get(inv.company_id) ?? []), inv]);

  for (const [companyId, list] of byCustomer) {
    const t = termFor(s, companyId);
    const method = methods[t.method];
    const totalOf = (inv: InvoiceRec) => invoiceTotal(s, inv);
    /** Pays on its habit: `delay` days after the due date (in one go, sometimes two instalments). */
    const usual = (inv: InvoiceRec) => {
      const due = Date.parse(inv.due_datetime);
      const at = dayAt(due, r.int(t.delay[0], t.delay[1]));
      const split = r.next() < 0.08;
      const firstGap = r.int(5, 10);
      if (at > now) return;
      const total = totalOf(inv);
      if (split && total > 300) {
        const first = Math.round(total * 0.5);
        pay(inv, first, Math.max(dayAt(Date.parse(inv.invoice_datetime), 1), at - firstGap * DAY_MS), method);
        pay(inv, total - first, at, method);
      } else pay(inv, total, at, method);
    };

    if (t.habit === 'worst') {
      const band: InvoiceRec[] = [];
      for (const inv of list) {
        const dpd = dpdOf(inv);
        const total = totalOf(inv);
        const due = Date.parse(inv.due_datetime);
        if (dpd > 120) pay(inv, total, dayAt(due, r.int(t.delay[0], t.delay[1])), method);
        else if (dpd > 60) band.push(inv);
        else if (dpd > 30) {
          // falling behind: about half paid late in full, the rest part-paid
          if (r.next() < 0.5) pay(inv, total, dayAt(due, r.int(15, dpd - 1)), method);
          else pay(inv, Math.round(total * 0.4), dayAt(due, r.int(5, dpd - 1)), method, 'Partial payment');
        }
        // dpd <= 30: nothing paid yet
      }
      // >60 days: the newest invoices stay unpaid until the target, one is part-paid, older ones were paid late
      const target = WORST_OVER_60_TARGET + r.int(150, 900);
      let owed = 0;
      for (const inv of [...band].sort((a, b) => dpdOf(a) - dpdOf(b))) {
        const total = totalOf(inv);
        const due = Date.parse(inv.due_datetime);
        const dpd = dpdOf(inv);
        if (owed + total <= target) owed += total;
        else if (owed < target) {
          const paid = Math.round(total - (target - owed));
          if (paid > 0) pay(inv, paid, dayAt(due, r.int(10, Math.min(40, dpd - 1))), method, 'Partial payment');
          owed = target;
        } else pay(inv, total, dayAt(due, r.int(25, Math.min(55, dpd - 1))), method);
      }
      continue;
    }

    let slowLeft = t.habit === 'slow' ? 2 : 0;
    let partialLeft = t.habit === 'partial_once' ? 1 : 0;
    for (const inv of list) {
      const dpd = dpdOf(inv);
      if (slowLeft > 0 && dpd >= 35 && dpd <= 55) {
        slowLeft--;
        continue; // unpaid, 31–60 days overdue
      }
      if (partialLeft > 0 && dpd >= 18 && dpd <= 28) {
        partialLeft--;
        pay(inv, Math.round(totalOf(inv) * 0.6), dayAt(Date.parse(inv.due_datetime), 3), method, 'Partial payment');
        continue;
      }
      usual(inv);
    }
  }

  // payment numbers count up chronologically
  pending.sort((a, b) => (a.payment_datetime === b.payment_datetime ? a.id.localeCompare(b.id) : a.payment_datetime < b.payment_datetime ? -1 : 1));
  for (const p of pending) {
    p.payment_number = `PMT-${++s.counters.payment}`;
    s.addPayment(p);
    const inv = s.invoices.get(p.invoice_id)!;
    if (p.payment_datetime > inv.updated_datetime) inv.updated_datetime = p.payment_datetime;
  }
}

export interface PaymentInput {
  payment_method_id: string;
  amount: number;
  payment_datetime: string;
  description: string | null;
  quickbooks_deposit_account_id: string | null;
  quickbooks_deposit_account_name: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** POST /invoices/{id}/payments body → input, or Distru-style validation errors. */
export function parsePaymentBody(s: Store, body: unknown): { ok: true; input: PaymentInput } | { ok: false; errors: ApiErrorItem[] } {
  if (!isObj(body)) return { ok: false, errors: [{ message: 'Request body must be a JSON object', pointer: ['base'] }] };
  const errors: ApiErrorItem[] = [];
  const methodId = body.payment_method_id;
  if (typeof methodId !== 'string' || !methodId) errors.push({ message: "can't be blank", pointer: ['payment_method_id'] });
  else {
    const m = s.paymentMethods.get(methodId);
    if (!m) errors.push({ message: 'does not exist', pointer: ['payment_method_id'] });
    else if (!m.active) errors.push({ message: 'is not active', pointer: ['payment_method_id'] });
  }
  const amount = typeof body.amount === 'number' ? body.amount : typeof body.amount === 'string' && body.amount.trim() !== '' ? Number(body.amount) : NaN;
  if (!Number.isFinite(amount) || amount < 0.01) errors.push({ message: 'must be a number of at least 0.01', pointer: ['amount'] });
  const at = body.payment_datetime;
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) errors.push({ message: 'must be an ISO8601 datetime', pointer: ['payment_datetime'] });
  const str = (k: string) => {
    const v = body[k];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') {
      errors.push({ message: 'must be a string', pointer: [k] });
      return null;
    }
    return v;
  };
  if (body.description === undefined || body.description === null) errors.push({ message: "can't be blank", pointer: ['description'] });
  const description = str('description');
  const qbId = str('quickbooks_deposit_account_id');
  const qbName = str('quickbooks_deposit_account_name');
  if (qbId !== null || qbName !== null) errors.push({ message: 'is not allowed: the company is not connected to QuickBooks Online', pointer: [qbId !== null ? 'quickbooks_deposit_account_id' : 'quickbooks_deposit_account_name'] });
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    input: {
      payment_method_id: methodId as string,
      amount: r2(amount),
      payment_datetime: new Date(at as string).toISOString(),
      description,
      quickbooks_deposit_account_id: qbId,
      quickbooks_deposit_account_name: qbName,
    },
  };
}

export type PaymentWrite =
  | { ok: true; payment: PaymentRec; invoice: InvoiceRec }
  | { ok: false; status: 400 | 404; errors: ApiErrorItem[] };

/** Records a payment: capped at the remaining balance, the excess becomes a customer credit. */
export function recordInvoicePayment(s: Store, invoiceId: string, body: unknown): PaymentWrite {
  const inv = s.invoices.get(invoiceId);
  if (!inv) return { ok: false, status: 404, errors: [{ message: 'Invoice not found', pointer: ['base'] }] };
  const parsed = parsePaymentBody(s, body);
  if (!parsed.ok) return { ok: false, status: 400, errors: parsed.errors };
  if (inv.voided_datetime) return { ok: false, status: 400, errors: [{ message: 'cannot record a payment against a voided invoice', pointer: ['base'] }] };
  const total = invoiceTotal(s, inv);
  const remaining = r2(total - s.invoicePaid(inv.id));
  if (remaining <= 0) return { ok: false, status: 400, errors: [{ message: 'invoice is already fully paid', pointer: ['base'] }] };
  const { input } = parsed;
  const applied = Math.min(input.amount, remaining);
  const excess = r2(input.amount - applied);
  const nowIso = s.nowIso();
  const payment: PaymentRec = {
    id: s.newId(),
    payment_number: `PMT-${++s.counters.payment}`,
    invoice_id: inv.id,
    company_id: inv.company_id,
    amount: r2(applied),
    payment_method_id: input.payment_method_id,
    payment_datetime: input.payment_datetime,
    description: input.description,
    status: 'POSTED',
    quickbooks_deposit_account_id: input.quickbooks_deposit_account_id,
    quickbooks_deposit_account_name: input.quickbooks_deposit_account_name,
    overpayment_credit: excess > 0 ? { id: s.newId(), credit_number: `CR-${++s.counters.credit}`, amount: excess } : null,
    inserted_datetime: nowIso,
    updated_datetime: nowIso,
  };
  s.addPayment(payment);
  inv.updated_datetime = nowIso;
  return { ok: true, payment, invoice: inv };
}
