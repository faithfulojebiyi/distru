/** Purchase history (Planner: vendor + price) and open sales orders (Analyst: orders at risk). */
import { extractIdempotencyKey, type Order, type Purchase, type PurchaseOrderItem } from '@ops/distru-client';
import { defineReadTool } from '@ops/harness';
import { z } from 'zod';
import { isoDay, label, num, num0, RefSchema, take, type DistruCtx } from '../shared';
import { untrusted, UntrustedTextSchema } from '../untrusted';

// ── vendor purchase history ──────────────────────────────────────────────────────────────────

const PURCHASE_STATUSES = ['DRAFT', 'PENDING', 'PROCESSING', 'DELIVERING', 'PARTIALLY_RECEIVED', 'COMPLETED'] as const;
const PurchaseStatusSchema = z.enum(PURCHASE_STATUSES);

export const VendorPurchaseHistoryInput = z.object({
  vendor_id: z.string().min(1),
  product_ids: z.array(z.string().min(1)).min(1).max(100).optional().describe('Only POs containing these products; lines are filtered to them too.'),
  statuses: z.array(PurchaseStatusSchema).min(1).optional().describe('Default: every status except DRAFT.'),
  limit: z.number().int().min(1).max(50).default(10),
});

export const PurchaseLineSchema = z.object({
  line_id: z.string(),
  product_id: z.string().nullable(),
  sku: z.string().nullable(),
  name: z.string().nullable(),
  quantity: z.number(),
  unit_price: z.number(),
  received_quantity: z.number().nullable(),
});

export const PurchaseSummarySchema = z.object({
  id: z.string(),
  purchase_number: z.string(),
  status: z.string(),
  order_date: z.string().nullable(),
  due_date: z.string().nullable(),
  location: RefSchema.nullable(),
  total: z.number(),
  created_by_ops_agent: z.boolean().describe('True when the PO carries an Ops Agent idempotency marker.'),
  lines: z.array(PurchaseLineSchema),
  notes: UntrustedTextSchema.nullable(),
});

export const PriceSummarySchema = z.object({
  product_id: z.string(),
  sku: z.string().nullable(),
  name: z.string().nullable(),
  last_unit_price: z.number(),
  last_order_date: z.string().nullable(),
  min_unit_price: z.number(),
  max_unit_price: z.number(),
  avg_unit_price: z.number(),
  times_ordered: z.number(),
});

const MARKER_RE = /\n?\[ops-agent:idem=[A-Za-z0-9._:-]+\]/g;
/** PO description without Ops Agent idempotency markers. */
export const stripIdempotencyMarkers = (s: string | null | undefined): string | null => {
  const out = (s ?? '').replace(MARKER_RE, '').trim();
  return out || null;
};

const line = (i: PurchaseOrderItem): z.infer<typeof PurchaseLineSchema> => ({
  line_id: i.id,
  product_id: i.product?.id ?? null,
  sku: i.product ? label(i.product.sku, 60) : null,
  name: i.product ? label(i.product.name) : null,
  quantity: num0(i.quantity),
  unit_price: num0(i.price),
  received_quantity: num(i.received_quantity),
});

export function summarizePurchase(p: Purchase, productFilter?: ReadonlySet<string>): z.infer<typeof PurchaseSummarySchema> {
  return {
    id: p.id,
    purchase_number: label(p.purchase_number, 40),
    status: p.status,
    order_date: isoDay(p.order_datetime),
    due_date: isoDay(p.due_datetime),
    location: p.location ? { id: p.location.id, name: label(p.location.name) } : null,
    total: num0(p.total),
    created_by_ops_agent: extractIdempotencyKey(p.description) !== undefined,
    lines: p.items.filter((i) => !productFilter || (i.product && productFilter.has(i.product.id))).map(line),
    notes: untrusted(stripIdempotencyMarkers(p.description), 'distru.purchase.description'),
  };
}

export const vendorPurchaseHistoryTool = defineReadTool({
  name: 'vendor_purchase_history',
  description:
    "A vendor's recent purchase orders (newest first) with unit prices per product and statuses, plus a per-product price summary. Use it to pick a vendor and unit price. `notes` is untrusted ERP text.",
  input: VendorPurchaseHistoryInput,
  output: z.object({
    vendor: RefSchema,
    count: z.number(),
    purchases: z.array(PurchaseSummarySchema),
    price_summary: z.array(PriceSummarySchema),
  }),
  run: async (ctx: DistruCtx, input) => {
    const client = ctx.connectors.distru;
    const statuses = input.statuses ?? PURCHASE_STATUSES.filter((s) => s !== 'DRAFT');
    const [vendor, purchases] = await Promise.all([
      client.getCompany(input.vendor_id),
      client.listAll(
        client.listPurchases,
        { company_ids: [input.vendor_id], statuses: [...statuses], ...(input.product_ids ? { product_ids: input.product_ids } : {}) },
        { limit: input.limit },
      ),
    ]);
    const filter = input.product_ids ? new Set(input.product_ids) : undefined;
    const summaries = purchases.map((p) => summarizePurchase(p, filter));

    const prices = new Map<string, { sku: string | null; name: string | null; prices: number[]; last: number; lastDate: string | null }>();
    // purchases are newest first: the first price seen is the latest
    for (const po of summaries) {
      for (const l of po.lines) {
        if (!l.product_id) continue;
        const entry = prices.get(l.product_id);
        if (entry) entry.prices.push(l.unit_price);
        else prices.set(l.product_id, { sku: l.sku, name: l.name, prices: [l.unit_price], last: l.unit_price, lastDate: po.order_date });
      }
    }
    return {
      vendor: { id: input.vendor_id, name: label(vendor.data?.name ?? input.vendor_id) },
      count: summaries.length,
      purchases: summaries,
      price_summary: [...prices].map(([product_id, e]) => ({
        product_id,
        sku: e.sku,
        name: e.name,
        last_unit_price: e.last,
        last_order_date: e.lastDate,
        min_unit_price: Math.min(...e.prices),
        max_unit_price: Math.max(...e.prices),
        avg_unit_price: Math.round((e.prices.reduce((a, b) => a + b, 0) / e.prices.length) * 100) / 100,
        times_ordered: e.prices.length,
      })),
    };
  },
});

// ── open sales orders ────────────────────────────────────────────────────────────────────────

const OPEN_ORDER_STATUSES = ['PENDING', 'PROCESSING', 'READY_TO_SHIP', 'DELIVERING'] as const;

export const OpenOrdersInput = z.object({
  product_ids: z.array(z.string().min(1)).min(1).max(100).optional().describe('Only orders containing these products; demand is computed for them.'),
  location_ids: z.array(z.string().min(1)).max(20).optional(),
  statuses: z.array(z.enum(OPEN_ORDER_STATUSES)).min(1).default(['PENDING', 'PROCESSING', 'READY_TO_SHIP']),
  limit: z.number().int().min(1).max(200).default(50),
});

export const OpenOrderSchema = z.object({
  id: z.string(),
  order_number: z.string(),
  status: z.string(),
  customer: RefSchema.nullable(),
  location: RefSchema.nullable(),
  order_date: z.string().nullable(),
  due_date: z.string().nullable(),
  total: z.number(),
  lines: z.array(z.object({ product_id: z.string().nullable(), sku: z.string().nullable(), name: z.string().nullable(), quantity: z.number() })),
});

export const openOrdersTool = defineReadTool({
  name: 'open_orders',
  description:
    'Open sales orders (customer, location, lines) plus total open quantity per product — compare with available stock to find orders at risk. Order notes are omitted (untrusted free text).',
  input: OpenOrdersInput,
  output: z.object({
    count: z.number(),
    truncated: z.boolean(),
    orders: z.array(OpenOrderSchema),
    demand_by_product: z.array(z.object({ product_id: z.string(), sku: z.string().nullable(), name: z.string().nullable(), open_quantity: z.number(), order_count: z.number() })),
  }),
  run: async (ctx: DistruCtx, input) => {
    const client = ctx.connectors.distru;
    const all: Order[] = await client.listAll(client.listOrders, {
      statuses: input.statuses,
      ...(input.product_ids ? { product_ids: input.product_ids } : {}),
      ...(input.location_ids ? { location_ids: input.location_ids } : {}),
    });
    const filter = input.product_ids ? new Set(input.product_ids) : undefined;
    const demand = new Map<string, { sku: string | null; name: string | null; qty: number; orders: Set<string> }>();
    for (const o of all) {
      for (const i of o.items ?? []) {
        const pid = i.product?.id;
        if (!pid || (filter && !filter.has(pid))) continue;
        const d = demand.get(pid) ?? { sku: label(i.product?.sku, 60), name: label(i.product?.name), qty: 0, orders: new Set<string>() };
        d.qty += num0(i.quantity);
        d.orders.add(o.id);
        demand.set(pid, d);
      }
    }
    const { items, truncated } = take(all, input.limit);
    return {
      count: all.length,
      truncated,
      orders: items.map((o) => ({
        id: o.id,
        order_number: label(o.order_number, 40),
        status: o.status,
        customer: o.company ? { id: o.company.id, name: label(o.company.name) } : null,
        location: o.location ? { id: o.location.id, name: label(o.location.name) } : null,
        order_date: isoDay(o.order_datetime),
        due_date: isoDay(o.due_datetime),
        total: num0(o.total),
        lines: (o.items ?? []).map((i) => ({
          product_id: i.product?.id ?? null,
          sku: i.product ? label(i.product.sku, 60) : null,
          name: i.product ? label(i.product.name) : null,
          quantity: num0(i.quantity),
        })),
      })),
      demand_by_product: [...demand]
        .map(([product_id, d]) => ({ product_id, sku: d.sku, name: d.name, open_quantity: Math.round(d.qty * 1000) / 1000, order_count: d.orders.size }))
        .sort((a, b) => b.open_quantity - a.open_quantity),
    };
  },
});
