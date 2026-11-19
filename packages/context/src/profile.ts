/**
 * Account profile: deterministic metrics computed in code from the unified layer (never by an LLM),
 * stored as versioned snapshots. Every number is explainable from rows an operator can inspect.
 */
import type { CompanyRow, CustomerProfile, Fact, OrderRow, ProductProfile, ProductRow, ProfileSnapshot, PurchaseRow, VendorProfile } from './model';
import type { ContextStore } from './store';
import { DISTRU_SOURCE } from './sync/normalize';
import { DAY_MS, groupBy, iso, mean, median, pctChange, percentile, round, sum, systemClock, type ContextClock } from './util';

export const OPEN_PURCHASE_STATUSES = ['PENDING', 'PROCESSING', 'DELIVERING', 'PARTIALLY_RECEIVED'];
export const CANCELED_ORDER_STATUSES = ['CANCELED', 'CANCELLED'];
/** A receipt counts as on time when it lands within this many days of the promised lead time. */
export const ON_TIME_GRACE_DAYS = 1;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RETAIL_SERIES_METRICS = new Set(['units_week', 'revenue_week']);

export interface ProfileOptions {
  clock?: ContextClock;
  source?: string;
  ids?: () => string;
  /** Persist the snapshot (default true). */
  save?: boolean;
}

export interface ProfileInputs {
  now: Date;
  source: string;
  companies: CompanyRow[];
  products: ProductRow[];
  purchases: PurchaseRow[];
  orders: OrderRow[];
  available: Map<string, number> | null;
  retailFacts: Fact[];
}

const days = (ms: number) => ms / DAY_MS;
const within = (at: string | null, fromMs: number, toMs: number) => {
  if (!at) return false;
  const t = Date.parse(at);
  return t > fromMs && t <= toMs;
};

export function vendorProfiles(inp: ProfileInputs): VendorProfile[] {
  const nowMs = inp.now.getTime();
  const companies = new Map(inp.companies.map((c) => [c.sourceId, c]));
  const products = new Map(inp.products.map((p) => [p.sourceId, p]));
  const pos = inp.purchases.filter((p) => p.vendorId && p.status !== 'DRAFT');
  const byVendor = groupBy(pos, (p) => p.vendorId!);
  const vendorIds = new Set([...inp.companies.filter((c) => c.relationship === 'vendor').map((c) => c.sourceId), ...byVendor.keys()]);
  const out: VendorProfile[] = [];
  for (const vendorId of vendorIds) {
    const list = byVendor.get(vendorId) ?? [];
    const company = companies.get(vendorId);
    const promised = company?.promisedLeadTimeDays ?? null;
    const leads = list
      .filter((p) => p.status === 'COMPLETED' && p.orderedAt && p.receivedAt)
      .map((p) => days(Date.parse(p.receivedAt!) - Date.parse(p.orderedAt!)))
      .filter((d) => d >= 0);
    const onTime = promised === null || !leads.length ? null : round((leads.filter((d) => d <= promised + ON_TIME_GRACE_DAYS).length / leads.length) * 100, 0);
    const receiving = list.filter((p) => p.status === 'COMPLETED' || p.status === 'PARTIALLY_RECEIVED');
    const ordered = sum(receiving.flatMap((p) => p.lines.map((l) => l.quantity)));
    const received = sum(receiving.flatMap((p) => p.lines.map((l) => Math.min(l.receivedQuantity, l.quantity))));
    const totals = list.map((p) => p.total).filter((t): t is number => t !== null);
    const lastOrderedAt = list.map((p) => p.orderedAt).filter((d): d is string => !!d).sort().at(-1) ?? null;

    // price trend per product: last unit price vs mean over the last 90 days
    const priced = list.flatMap((p) => (p.orderedAt ? p.lines.filter((l) => l.productId && l.unitPrice !== null).map((l) => ({ productId: l.productId!, price: l.unitPrice!, at: p.orderedAt! })) : []));
    const priceTrends = [...groupBy(priced, (x) => x.productId).entries()]
      .map(([productId, xs]) => {
        const last = [...xs].sort((a, b) => (a.at < b.at ? -1 : 1)).at(-1)!;
        const recent = xs.filter((x) => within(x.at, nowMs - 90 * DAY_MS, nowMs)).map((x) => x.price);
        const avg = mean(recent);
        const product = products.get(productId);
        return {
          productId,
          sku: product?.sku ?? null,
          name: product?.name ?? null,
          lastPrice: last.price,
          lastOrderedAt: last.at,
          avg90d: avg === null ? null : round(avg, 2),
          changePct: avg === null ? null : pctChange(last.price, avg),
          samples90d: recent.length,
        };
      })
      .sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0))
      .slice(0, 10);

    const actual = median(leads);
    const p90 = percentile(leads, 90);
    const avgTotal = mean(totals);
    out.push({
      vendorId,
      name: company?.name ?? vendorId,
      promisedLeadTimeDays: promised,
      actualLeadTimeDays: actual === null ? null : round(actual, 1),
      leadTimeP90Days: p90 === null ? null : round(p90, 1),
      leadTimeSamples: leads.length,
      onTimePct: onTime,
      fillRatePct: ordered > 0 ? round((received / ordered) * 100, 1) : null,
      purchaseCount: list.length,
      openPurchaseCount: list.filter((p) => OPEN_PURCHASE_STATUSES.includes(p.status)).length,
      avgPurchaseTotal: avgTotal === null ? null : round(avgTotal, 2),
      lastOrderedAt,
      priceTrends,
    });
  }
  return out.sort((a, b) => b.purchaseCount - a.purchaseCount || a.name.localeCompare(b.name));
}

export function productProfiles(inp: ProfileInputs): ProductProfile[] {
  const nowMs = inp.now.getTime();
  const orders = inp.orders.filter((o) => !CANCELED_ORDER_STATUSES.includes(o.status) && o.orderedAt);
  const unitsBy = new Map<string, { last: number; prior: number; weekday: number[] }>();
  for (const o of orders) {
    const t = Date.parse(o.orderedAt!);
    const age = nowMs - t;
    if (age < 0 || age > 84 * DAY_MS) continue;
    const dow = new Date(t).getUTCDay();
    for (const l of o.lines) {
      if (!l.productId) continue;
      const u = unitsBy.get(l.productId) ?? { last: 0, prior: 0, weekday: [0, 0, 0, 0, 0, 0, 0] };
      if (age <= 28 * DAY_MS) u.last += l.quantity;
      else if (age <= 56 * DAY_MS) u.prior += l.quantity;
      u.weekday[dow]! += l.quantity;
      unitsBy.set(l.productId, u);
    }
  }
  const retailBySku = groupBy(
    inp.retailFacts.filter((f) => !RETAIL_SERIES_METRICS.has(f.metric)),
    (f) => f.entityKey,
  );
  return inp.products.map((p): ProductProfile => {
    const u = unitsBy.get(p.sourceId) ?? { last: 0, prior: 0, weekday: [0, 0, 0, 0, 0, 0, 0] };
    const perDay = u.last / 28;
    const perDayPrior = u.prior / 28;
    const trend = u.prior > 0 ? pctChange(u.last, u.prior) : null;
    const direction: ProductProfile['demandDirection'] =
      u.last === 0 && u.prior === 0 ? 'none' : u.prior === 0 ? 'up' : trend! >= 10 ? 'up' : trend! <= -10 ? 'down' : 'flat';
    const weekTotal = sum(u.weekday);
    const weekdayIndex = weekTotal > 0 ? u.weekday.map((x) => round(x / (weekTotal / 7), 2)) : [];
    let hint: string | null = null;
    if (weekTotal >= 28) {
      const peaks = weekdayIndex.map((x, i) => ({ x, i })).filter((d) => d.x >= 1.15);
      const lows = weekdayIndex.map((x, i) => ({ x, i })).filter((d) => d.x <= 0.75);
      const parts: string[] = [];
      if (peaks.length) parts.push(`busiest ${peaks.map((d) => WEEKDAYS[d.i]).join('/')} (~+${Math.round((mean(peaks.map((d) => d.x))! - 1) * 100)}% vs avg day)`);
      if (lows.length) parts.push(`slowest ${lows.map((d) => WEEKDAYS[d.i]).join('/')} (~${Math.round((mean(lows.map((d) => d.x))! - 1) * 100)}%)`);
      hint = parts.length ? parts.join('; ') : null;
    }
    const available = inp.available ? (inp.available.get(p.sourceId) ?? 0) : null;
    const retailFacts = p.sku ? (retailBySku.get(p.sku) ?? []) : [];
    let retail: ProductProfile['retail'] = null;
    if (retailFacts.length) {
      const latestAt = retailFacts.map((f) => f.observedAt).sort().at(-1)!;
      const metrics: Record<string, number> = {};
      for (const f of retailFacts) if (f.observedAt === latestAt) metrics[f.metric] = f.value;
      retail = { source: retailFacts[0]!.source, observedAt: latestAt, metrics };
    }
    return {
      productId: p.sourceId,
      sku: p.sku,
      name: p.name,
      vendorId: p.vendorId,
      isActive: p.isActive,
      unitsPerDay28d: round(perDay, 2),
      unitsPerDayPrior28d: round(perDayPrior, 2),
      demandTrendPct: trend,
      demandDirection: direction,
      weekdayIndex,
      seasonalityHint: hint,
      available,
      daysOfSupply: available !== null && perDay > 0 ? round(available / perDay, 1) : null,
      retail,
    };
  });
}

export function customerProfiles(inp: ProfileInputs): CustomerProfile[] {
  const nowMs = inp.now.getTime();
  const products = new Map(inp.products.map((p) => [p.sourceId, p]));
  const orders = inp.orders.filter((o) => o.customerId && o.orderedAt && !CANCELED_ORDER_STATUSES.includes(o.status));
  const byCustomer = groupBy(orders, (o) => o.customerId!);
  const ids = new Set([...inp.companies.filter((c) => c.relationship === 'customer').map((c) => c.sourceId), ...byCustomer.keys()]);
  const names = new Map(inp.companies.map((c) => [c.sourceId, c.name]));
  const out: CustomerProfile[] = [];
  for (const customerId of ids) {
    const list = [...(byCustomer.get(customerId) ?? [])].sort((a, b) => (a.orderedAt! < b.orderedAt! ? -1 : 1));
    const times = list.map((o) => Date.parse(o.orderedAt!));
    const gaps = times.slice(1).map((t, i) => days(t - times[i]!));
    const cadence = median(gaps);
    const last = times.at(-1);
    const since = last === undefined ? null : round(days(nowMs - last), 1);
    const recent = list.filter((o) => within(o.orderedAt, nowMs - 90 * DAY_MS, nowMs));
    const units = new Map<string, number>();
    for (const o of recent) for (const l of o.lines) if (l.productId) units.set(l.productId, (units.get(l.productId) ?? 0) + l.quantity);
    const totals = list.map((o) => o.total).filter((t): t is number => t !== null);
    const avg = mean(totals);
    out.push({
      customerId,
      name: names.get(customerId) ?? customerId,
      orderCount: list.length,
      orderCount90d: recent.length,
      cadenceDays: cadence === null ? null : round(cadence, 1),
      lastOrderAt: last === undefined ? null : iso(last),
      daysSinceLastOrder: since,
      overdue: cadence !== null && since !== null && list.length >= 3 && since > Math.max(1.5 * cadence, cadence + 2),
      avgOrderTotal: avg === null ? null : round(avg, 2),
      topSkus: [...units.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([productId, u]) => ({ productId, sku: products.get(productId)?.sku ?? null, name: products.get(productId)?.name ?? null, units90d: u })),
    });
  }
  return out.sort((a, b) => b.orderCount90d - a.orderCount90d || a.name.localeCompare(b.name));
}

export async function loadProfileInputs(store: ContextStore, now: Date, source = DISTRU_SOURCE): Promise<ProfileInputs> {
  const [companies, products, purchases, orders, inventory, retailFacts] = await Promise.all([
    store.list('company', { source }),
    store.list('product', { source }),
    store.list('purchase', { source }),
    store.list('order', { source, from: iso(now.getTime() - 365 * DAY_MS) }),
    store.latestInventory(source),
    store.listFacts({ entityType: 'product' }),
  ]);
  let available: Map<string, number> | null = null;
  if (inventory) {
    available = new Map();
    for (const r of inventory.rows) available.set(r.productId, (available.get(r.productId) ?? 0) + r.available);
  }
  return { now, source, companies, products, purchases, orders, available, retailFacts: retailFacts.filter((f) => f.source !== source) };
}

/** Computes the account profile from the unified layer and stores it as the next versioned snapshot. */
export async function buildProfile(store: ContextStore, opts: ProfileOptions = {}): Promise<ProfileSnapshot> {
  const now = (opts.clock ?? systemClock).now();
  const inp = await loadProfileInputs(store, now, opts.source);
  const vendors = vendorProfiles(inp);
  const products = productProfiles(inp);
  const customers = customerProfiles(inp);
  const snapshot: Omit<ProfileSnapshot, 'version'> = {
    id: (opts.ids ?? (() => crypto.randomUUID()))(),
    computedAt: iso(now),
    source: inp.source,
    counts: { vendors: vendors.length, products: products.length, customers: customers.length, purchases: inp.purchases.length, orders: inp.orders.length },
    vendors,
    products,
    customers,
  };
  if (opts.save === false) return { ...snapshot, version: 0 };
  return store.saveProfile(snapshot);
}
