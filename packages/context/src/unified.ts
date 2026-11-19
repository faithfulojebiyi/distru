/**
 * `unified_query`: a safe, parameterized, read-only query surface over the unified layer. The model
 * picks a predefined shape and fills typed parameters; there is no raw SQL and no free-form filter
 * language. Every shape caps its rows.
 */
import { z } from 'zod';
import type { ContextStore } from './store';
import { DISTRU_SOURCE } from './sync/normalize';
import { DAY_MS, iso, round, safeLabel, systemClock, type ContextClock } from './util';

const ids = z.array(z.string().min(1)).max(200).optional();
const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO date');
const limit = (dflt: number) => z.number().int().positive().max(200).default(dflt);

export const UnifiedQuerySchema = z.discriminatedUnion('shape', [
  z.object({
    shape: z.literal('stock_by_product_location'),
    product_ids: ids,
    skus: ids,
    location_ids: ids,
    only_available: z.boolean().default(false),
    limit: limit(100),
  }),
  z.object({
    shape: z.literal('purchases_by_vendor'),
    vendor_ids: ids,
    from: isoDate.optional(),
    to: isoDate.optional(),
    statuses: z.array(z.string()).max(10).optional(),
    limit: limit(50),
  }),
  z.object({
    shape: z.literal('sales_by_product_week'),
    product_ids: ids,
    skus: ids,
    /** Weeks back from now when `from` is not given. */
    weeks: z.number().int().positive().max(26).default(8),
    from: isoDate.optional(),
    to: isoDate.optional(),
    limit: limit(100),
  }),
  z.object({
    shape: z.literal('sales_by_customer'),
    customer_ids: ids,
    from: isoDate.optional(),
    to: isoDate.optional(),
    limit: limit(50),
  }),
  z.object({
    shape: z.literal('facts'),
    source: z.string().optional(),
    entity_type: z.string().optional(),
    entity_keys: ids,
    metrics: z.array(z.string()).max(20).optional(),
    since: isoDate.optional(),
    limit: limit(100),
  }),
]);
export type UnifiedQuery = z.input<typeof UnifiedQuerySchema>;

export interface UnifiedQueryResult {
  shape: string;
  rows: Record<string, string | number | boolean | null>[];
  truncated: boolean;
  /** What the rows are, for the model. */
  note: string;
}

const weekStart = (t: number) => {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
};

function cap<T>(rows: T[], n: number): { rows: T[]; truncated: boolean } {
  return { rows: rows.slice(0, n), truncated: rows.length > n };
}

export async function runUnifiedQuery(store: ContextStore, raw: unknown, opts: { clock?: ContextClock; source?: string } = {}): Promise<UnifiedQueryResult> {
  const q = UnifiedQuerySchema.parse(raw);
  const now = (opts.clock ?? systemClock).now().getTime();
  const source = opts.source ?? DISTRU_SOURCE;
  const products = await store.list('product', { source });
  const productById = new Map(products.map((p) => [p.sourceId, p]));
  const resolveProducts = (pids?: string[], skus?: string[]) => {
    if (!pids && !skus) return null;
    const out = new Set(pids ?? []);
    for (const p of products) if (p.sku && skus?.includes(p.sku)) out.add(p.sourceId);
    return [...out];
  };

  switch (q.shape) {
    case 'stock_by_product_location': {
      const snap = await store.latestInventory(source);
      const wanted = resolveProducts(q.product_ids, q.skus);
      const rows = (snap?.rows ?? [])
        .filter((r) => (!wanted || wanted.includes(r.productId)) && (!q.location_ids || q.location_ids.includes(r.locationId)) && (!q.only_available || r.available > 0))
        .map((r) => ({
          product_id: r.productId,
          sku: productById.get(r.productId)?.sku ?? null,
          name: safeLabel(productById.get(r.productId)?.name),
          location_id: r.locationId || null,
          active: r.active,
          reserved: r.reserved,
          available: r.available,
        }))
        .sort((a, b) => (a.sku ?? '').localeCompare(b.sku ?? '') || (a.location_id ?? '').localeCompare(b.location_id ?? ''));
      return { shape: q.shape, ...cap(rows, q.limit), note: `Stock per product and location from the inventory snapshot at ${snap?.snapshotAt ?? 'n/a'}.` };
    }
    case 'purchases_by_vendor': {
      const companies = new Map((await store.list('company', { source })).map((c) => [c.sourceId, c]));
      const list = await store.list('purchase', { source, ...(q.vendor_ids ? { partyIds: q.vendor_ids } : {}), ...(q.from ? { from: q.from } : {}), ...(q.to ? { to: q.to } : {}), ...(q.statuses ? { statuses: q.statuses } : {}) });
      const rows = list
        .sort((a, b) => ((a.orderedAt ?? '') < (b.orderedAt ?? '') ? 1 : -1))
        .map((p) => ({
          purchase_id: p.sourceId,
          number: p.number,
          vendor_id: p.vendorId,
          vendor: safeLabel(p.vendorId ? companies.get(p.vendorId)?.name : null),
          status: p.status,
          ordered_at: p.orderedAt,
          received_at: p.receivedAt,
          total: p.total,
          lines: p.lines.length,
          units: p.lines.reduce((s, l) => s + l.quantity, 0),
        }));
      return { shape: q.shape, ...cap(rows, q.limit), note: 'Purchases (newest first) from the unified layer.' };
    }
    case 'sales_by_product_week': {
      const from = q.from ?? iso(now - q.weeks * 7 * DAY_MS);
      const wanted = resolveProducts(q.product_ids, q.skus);
      const orders = await store.list('order', { source, from, ...(q.to ? { to: q.to } : {}) });
      const agg = new Map<string, { units: number; revenue: number; orders: number }>();
      for (const o of orders) {
        if (o.status === 'CANCELED' || !o.orderedAt) continue;
        const wk = weekStart(Date.parse(o.orderedAt));
        for (const l of o.lines) {
          if (!l.productId || (wanted && !wanted.includes(l.productId))) continue;
          const k = `${l.productId}\u0000${wk}`;
          const a = agg.get(k) ?? { units: 0, revenue: 0, orders: 0 };
          a.units += l.quantity;
          a.revenue += l.quantity * (l.unitPrice ?? 0);
          a.orders++;
          agg.set(k, a);
        }
      }
      const rows = [...agg.entries()]
        .map(([k, a]) => {
          const [pid, wk] = k.split('\u0000') as [string, string];
          return { product_id: pid, sku: productById.get(pid)?.sku ?? null, week_start: wk, units: a.units, revenue: round(a.revenue, 2), order_lines: a.orders };
        })
        .sort((a, b) => (a.sku ?? '').localeCompare(b.sku ?? '') || a.week_start.localeCompare(b.week_start));
      return { shape: q.shape, ...cap(rows, q.limit), note: `Units sold per product per ISO week (Monday start, UTC) since ${from.slice(0, 10)}; canceled orders excluded.` };
    }
    case 'sales_by_customer': {
      const companies = new Map((await store.list('company', { source })).map((c) => [c.sourceId, c]));
      const from = q.from ?? iso(now - 90 * DAY_MS);
      const orders = await store.list('order', { source, from, ...(q.to ? { to: q.to } : {}), ...(q.customer_ids ? { partyIds: q.customer_ids } : {}) });
      const agg = new Map<string, { orders: number; units: number; revenue: number; last: string }>();
      for (const o of orders) {
        if (o.status === 'CANCELED' || !o.customerId) continue;
        const a = agg.get(o.customerId) ?? { orders: 0, units: 0, revenue: 0, last: '' };
        a.orders++;
        a.units += o.lines.reduce((s, l) => s + l.quantity, 0);
        a.revenue += o.total ?? 0;
        if ((o.orderedAt ?? '') > a.last) a.last = o.orderedAt ?? '';
        agg.set(o.customerId, a);
      }
      const rows = [...agg.entries()]
        .map(([cid, a]) => ({ customer_id: cid, customer: safeLabel(companies.get(cid)?.name), orders: a.orders, units: a.units, revenue: round(a.revenue, 2), last_order_at: a.last || null }))
        .sort((a, b) => b.revenue - a.revenue);
      return { shape: q.shape, ...cap(rows, q.limit), note: `Sales per customer since ${from.slice(0, 10)}; canceled orders excluded.` };
    }
    case 'facts': {
      const facts = await store.listFacts({ ...(q.source ? { source: q.source } : {}), ...(q.entity_type ? { entityType: q.entity_type } : {}), ...(q.entity_keys ? { entityKeys: q.entity_keys } : {}), ...(q.metrics ? { metrics: q.metrics } : {}), ...(q.since ? { since: q.since } : {}) });
      const rows = facts
        .reverse()
        .map((f) => ({ source: f.source, entity_type: f.entityType, entity_key: f.entityKey, metric: f.metric, value: f.value, observed_at: f.observedAt }));
      return { shape: q.shape, ...cap(rows, q.limit), note: 'Facts from all connectors (newest first).' };
    }
  }
}
