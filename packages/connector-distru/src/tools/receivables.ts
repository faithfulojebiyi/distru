/**
 * Accounts receivable (read-only): overdue balances by customer with aging buckets, and an invoice
 * search. Invoice notes are customer-visible / internal free text and are omitted (untrusted, and not
 * needed to chase a balance).
 */
import type { Invoice, ListInvoicesParams } from '@ops/distru-client';
import { defineReadTool } from '@ops/harness';
import { z } from 'zod';
import { IdList, isoDay, label, num0, RefSchema, take, type DistruCtx } from '../shared';

const DAY = 86_400_000;
const OPEN_STATUSES = ['NOT_PAID', 'PARTIALLY_PAID'] as const;
const INVOICE_STATUSES = ['NOT_PAID', 'PARTIALLY_PAID', 'FULLY_PAID', 'OVER_PAID'] as const;

const round2 = (n: number) => Math.round(n * 100) / 100;
const startOfDay = (ms: number) => Math.floor(ms / DAY) * DAY;

/** Whole days an invoice is past due on `asOf` (UTC days; 0 or less = not yet due). */
export function daysOverdue(dueIso: string | null | undefined, asOf: Date): number {
  if (!dueIso) return 0;
  return Math.floor((startOfDay(asOf.getTime()) - startOfDay(Date.parse(dueIso))) / DAY);
}

export const AGING_BUCKETS = ['d0_30', 'd31_60', 'd61_90', 'd90_plus'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

/** 1–30 → d0_30, 31–60 → d31_60, 61–90 → d61_90, more → d90_plus. */
export function agingBucket(days: number): AgingBucket {
  if (days <= 30) return 'd0_30';
  if (days <= 60) return 'd31_60';
  if (days <= 90) return 'd61_90';
  return 'd90_plus';
}

const AgingSchema = z
  .object({ d0_30: z.number(), d31_60: z.number(), d61_90: z.number(), d90_plus: z.number() })
  .describe('Amount past due by days overdue: 1–30, 31–60, 61–90, over 90.');

const emptyAging = (): z.infer<typeof AgingSchema> => ({ d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 });

export const InvoiceSummarySchema = z.object({
  id: z.string(),
  invoice_number: z.string(),
  customer: RefSchema.nullable(),
  order_number: z.string().nullable(),
  status: z.string(),
  invoice_date: z.string().nullable(),
  due_date: z.string().nullable(),
  payment_terms: z.string().nullable(),
  days_overdue: z.number().describe('Days past the due date as of `as_of`; 0 when not yet due or paid.'),
  total: z.number(),
  paid: z.number(),
  remaining: z.number(),
  payments: z.number().describe('Number of payments recorded'),
  last_payment_date: z.string().nullable(),
});
export type InvoiceSummary = z.infer<typeof InvoiceSummarySchema>;

export function summarizeInvoice(inv: Invoice, asOf: Date): InvoiceSummary {
  const remaining = num0(inv.remaining_amount);
  const payments = inv.payments ?? [];
  const last = payments.map((p) => p.payment_datetime).sort().at(-1) ?? null;
  return {
    id: inv.id,
    invoice_number: label(inv.invoice_number, 40),
    customer: inv.company ? { id: inv.company.id, name: label(inv.company.name) } : null,
    order_number: inv.order ? label(inv.order.order_number, 40) : null,
    status: inv.status,
    invoice_date: isoDay(inv.invoice_datetime),
    due_date: isoDay(inv.due_datetime),
    payment_terms: inv.payment_term_name ? label(inv.payment_term_name, 40) : null,
    days_overdue: remaining > 0 ? Math.max(0, daysOverdue(inv.due_datetime, asOf)) : 0,
    total: num0(inv.total),
    paid: num0(inv.paid_amount),
    remaining,
    payments: payments.length,
    last_payment_date: isoDay(last),
  };
}

const asOfOf = (v: string | undefined) => (v ? new Date(`${v}T23:59:59.999Z`) : new Date());

// ── invoices_overdue ─────────────────────────────────────────────────────────────────────────

export const InvoicesOverdueInput = z.object({
  customer_ids: IdList.optional().describe('Only these customers (Distru company ids)'),
  as_of: z.iso.date().optional().describe('YYYY-MM-DD; default today. Invoices due before this day and not fully paid count as overdue.'),
  min_days_overdue: z.number().int().min(1).max(365).default(1).describe('Ignore invoices less overdue than this'),
  limit: z.number().int().min(1).max(50).default(20).describe('Max customers returned (worst first)'),
  invoices_per_customer: z.number().int().min(0).max(20).default(5).describe('Oldest overdue invoices listed per customer'),
});

export const OverdueCustomerSchema = z.object({
  customer: RefSchema,
  invoice_count: z.number(),
  total_due: z.number().describe('Sum of remaining balances on overdue invoices'),
  oldest_days_overdue: z.number(),
  aging: AgingSchema,
  partially_paid: z.number().describe('How many of the overdue invoices have a partial payment'),
  last_payment_date: z.string().nullable().describe('Latest payment on any of these invoices'),
  invoices: z.array(InvoiceSummarySchema).describe('Oldest overdue first'),
});

export const InvoicesOverdueOutput = z.object({
  as_of: z.string(),
  customer_count: z.number(),
  invoice_count: z.number(),
  total_due: z.number(),
  aging: AgingSchema,
  truncated: z.boolean(),
  customers: z.array(OverdueCustomerSchema).describe('Worst first (most past due)'),
});

export const invoicesOverdueTool = defineReadTool({
  name: 'invoices_overdue',
  description:
    'Accounts receivable aging: overdue customer invoices (past due, not fully paid) grouped by customer, worst first, with count, total due, oldest days overdue and aging buckets (1–30, 31–60, 61–90, 90+ days). Use it to see who owes money and how late it is.',
  input: InvoicesOverdueInput,
  output: InvoicesOverdueOutput,
  run: async (ctx: DistruCtx, input) => {
    const client = ctx.connectors.distru;
    const asOf = asOfOf(input.as_of);
    // due at least `min_days_overdue` days before as_of
    const dueBy = new Date(startOfDay(asOf.getTime()) - (input.min_days_overdue - 1) * DAY - 1).toISOString();
    const params: ListInvoicesParams = {
      statuses: [...OPEN_STATUSES],
      is_voided: false,
      remaining_amount: '0.01,',
      due_datetime: `,${dueBy}`,
      ...(input.customer_ids ? { company_ids: input.customer_ids } : {}),
    };
    const invoices = await client.listAll(client.listInvoices, params);
    const by = new Map<string, { customer: { id: string; name: string }; rows: InvoiceSummary[] }>();
    for (const inv of invoices) {
      const s = summarizeInvoice(inv, asOf);
      if (s.remaining <= 0 || s.days_overdue < input.min_days_overdue) continue;
      const id = s.customer?.id ?? 'unknown';
      const entry = by.get(id) ?? { customer: s.customer ?? { id, name: 'Unknown customer' }, rows: [] };
      entry.rows.push(s);
      by.set(id, entry);
    }
    const all = [...by.values()].map(({ customer, rows }) => {
      const aging = emptyAging();
      for (const r of rows) aging[agingBucket(r.days_overdue)] = round2(aging[agingBucket(r.days_overdue)] + r.remaining);
      const sorted = [...rows].sort((a, b) => b.days_overdue - a.days_overdue || a.invoice_number.localeCompare(b.invoice_number));
      return {
        customer,
        invoice_count: rows.length,
        total_due: round2(rows.reduce((a, r) => a + r.remaining, 0)),
        oldest_days_overdue: sorted[0]?.days_overdue ?? 0,
        aging,
        partially_paid: rows.filter((r) => r.paid > 0).length,
        last_payment_date: rows.map((r) => r.last_payment_date).filter((d): d is string => !!d).sort().at(-1) ?? null,
        invoices: sorted.slice(0, input.invoices_per_customer),
      };
    });
    // worst first: most money more than 60 days late, then total due
    all.sort((a, b) => b.aging.d61_90 + b.aging.d90_plus - (a.aging.d61_90 + a.aging.d90_plus) || b.total_due - a.total_due);
    const totals = emptyAging();
    for (const c of all) for (const k of AGING_BUCKETS) totals[k] = round2(totals[k] + c.aging[k]);
    const { items, truncated } = take(all, input.limit);
    return {
      as_of: isoDay(asOf.toISOString())!,
      customer_count: all.length,
      invoice_count: all.reduce((a, c) => a + c.invoice_count, 0),
      total_due: round2(all.reduce((a, c) => a + c.total_due, 0)),
      aging: totals,
      truncated,
      customers: items,
    };
  },
});

// ── invoices_search ──────────────────────────────────────────────────────────────────────────

export const InvoicesSearchInput = z.object({
  customer_ids: IdList.optional(),
  statuses: z.array(z.enum(INVOICE_STATUSES)).min(1).optional().describe('Payment statuses; default all'),
  invoice_number: z.string().trim().min(1).max(40).optional().describe('Contains (case-insensitive)'),
  order_numbers: z.array(z.string().trim().min(1).max(40)).min(1).max(50).optional().describe('Exact sales order numbers, e.g. SO-1042'),
  invoice_date_from: z.iso.date().optional(),
  invoice_date_to: z.iso.date().optional(),
  due_date_from: z.iso.date().optional(),
  due_date_to: z.iso.date().optional(),
  overdue_only: z.boolean().default(false).describe('Only invoices past due with a balance left'),
  min_remaining: z.number().min(0).optional().describe('Only invoices with at least this balance left'),
  as_of: z.iso.date().optional().describe('YYYY-MM-DD for days_overdue; default today'),
  limit: z.number().int().min(1).max(100).default(25),
});

/** invoices_search reads at most this many matches (20 pages) for its count and totals. */
export const INVOICE_SCAN_MAX = 500;

export const InvoicesSearchOutput = z.object({
  count: z.number().describe(`Matching invoices scanned (at most ${INVOICE_SCAN_MAX})`),
  scan_complete: z.boolean().describe('False when more than the scan limit matched: narrow the filters for exact totals'),
  truncated: z.boolean(),
  totals: z.object({ total: z.number(), paid: z.number(), remaining: z.number() }).describe('Over every scanned match, not just the returned page'),
  invoices: z.array(InvoiceSummarySchema).describe('Newest first'),
});

export const invoicesSearchTool = defineReadTool({
  name: 'invoices_search',
  description:
    'Search customer invoices (newest first) by customer, payment status, invoice or order number, invoice/due date range, balance left, or overdue only. Returns totals, paid, remaining and days overdue per invoice. Notes are omitted.',
  input: InvoicesSearchInput,
  output: InvoicesSearchOutput,
  run: async (ctx: DistruCtx, input) => {
    const client = ctx.connectors.distru;
    const asOf = asOfOf(input.as_of);
    const range = (from?: string, to?: string) => (from || to ? `${from ? `${from}T00:00:00Z` : ''},${to ? `${to}T23:59:59Z` : ''}` : undefined);
    const invoiceRange = range(input.invoice_date_from, input.invoice_date_to);
    let dueRange = range(input.due_date_from, input.due_date_to);
    let statuses = input.statuses ? [...input.statuses] : undefined;
    let minRemaining = input.min_remaining;
    if (input.overdue_only) {
      const dueBy = new Date(startOfDay(asOf.getTime()) - 1).toISOString();
      const [from = '', to = ''] = (dueRange ?? ',').split(',');
      dueRange = `${from},${to && to < dueBy ? to : dueBy}`;
      statuses = (statuses ?? [...OPEN_STATUSES]).filter((s) => (OPEN_STATUSES as readonly string[]).includes(s));
      minRemaining = Math.max(minRemaining ?? 0, 0.01);
    }
    if (statuses && !statuses.length) return { count: 0, scan_complete: true, truncated: false, totals: { total: 0, paid: 0, remaining: 0 }, invoices: [] };
    const params: ListInvoicesParams = {
      ...(input.customer_ids ? { company_ids: input.customer_ids } : {}),
      ...(statuses ? { statuses } : {}),
      ...(input.invoice_number ? { invoice_number: input.invoice_number } : {}),
      ...(input.order_numbers ? { order_numbers: input.order_numbers } : {}),
      ...(invoiceRange ? { invoice_datetime: invoiceRange } : {}),
      ...(dueRange ? { due_datetime: dueRange } : {}),
      ...(minRemaining !== undefined ? { remaining_amount: `${minRemaining},` } : {}),
    };
    const scanned = await client.listAll(client.listInvoices, params, { limit: INVOICE_SCAN_MAX + 1 });
    const invoices = scanned.slice(0, INVOICE_SCAN_MAX).map((inv) => summarizeInvoice(inv, asOf));
    const { items, truncated } = take(invoices, input.limit);
    return {
      count: invoices.length,
      scan_complete: scanned.length <= INVOICE_SCAN_MAX,
      truncated,
      totals: {
        total: round2(invoices.reduce((a, i) => a + i.total, 0)),
        paid: round2(invoices.reduce((a, i) => a + i.paid, 0)),
        remaining: round2(invoices.reduce((a, i) => a + i.remaining, 0)),
      },
      invoices: items,
    };
  },
});

/**
 * The AR read tools. Not in `distruConnector.readTools` yet: registering them changes the catalog every
 * agent and the MCP server see (and the eval recordings keyed on it). Register them with
 * `defineConnector({ ...distruConnector, readTools: [...distruConnector.readTools, ...DISTRU_RECEIVABLES_TOOLS] })`
 * (or add them to the connector), then grant them per agent in AGENT_TOOLS.
 */
export const DISTRU_RECEIVABLES_TOOLS = [invoicesOverdueTool, invoicesSearchTool] as const;
