/**
 * Twelve months of history on top of the 120-day core seed (seed.ts), drawn from their own PRNGs so the
 * core seed's ids and its last-120-day sales are untouched:
 *
 * - **Older sales** (121–365 days ago) with mild calendar seasonality: a holiday bump (late Nov–Dec), the
 *   4/20 week, a January lull and a summer dip (Jun–Aug). Numbered SO-<n> below the core seed's SO-1001,
 *   chronologically. They feed the 365-day half of Distru's demand rate, so stock is calibrated after them.
 * - **Older purchase orders**: 5–9 more COMPLETED POs per vendor across the year (8–12 in total), numbered
 *   below PO-501. Every vendor gets one price increase on its most recent completed PO (`applyPriceIncreases`).
 * - **Receipt variation** (`poVariation`, on by default): a few late receipts (lead time > promised) and short
 *   shipments (received < ordered) per vendor. The draws happen either way, so ids never depend on it.
 */
import { rng, type Store } from './store';
import type { BatchRec, OrderItemRec, OrderRec, OrderStatus, ProductRec, PurchaseItemRec, PurchaseRec } from './types';
import { DAY_MS } from './util';

/** Days of history the core seed generates; older sales start the day before. */
export const CORE_HISTORY_DAYS = 120;
export const YEAR_DAYS = 365;

/**
 * Calendar demand multiplier for older sales (UTC date). Mild by design: the 95th-percentile reorder
 * point looks back 365 days, so big spikes would dominate it.
 */
export function seasonality(date: Date): number {
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  if (m === 3 && d >= 14 && d <= 20) return d === 20 ? 1.6 : 1.25; // 4/20 week
  if (m === 11) return d >= 18 ? 1.25 : 1.15; // holidays
  if (m === 10 && d >= 24) return 1.12; // Green Wednesday / Black Friday
  if (m === 0) return 0.9; // January lull
  if (m >= 5 && m <= 7) return 0.86; // summer dip
  return 1;
}

export interface OlderSalesInput {
  store: Store;
  products: ProductRec[];
  /** mean units/day by SKU (the catalog's demand) */
  demandBySku: ReadonlyMap<string, number>;
  customerIds: readonly string[];
  /** where each customer's orders bill and ship to */
  customerLoc: ReadonlyMap<string, string>;
  /** [Oakland, Los Angeles, Sacramento] */
  locations: readonly [string, string, string];
  today: number;
  inactiveSku: string;
}

/** Sales orders 121–365 days ago. Returns them oldest first (already in the store). */
export function seedOlderSales(o: OlderSalesInput): OrderRec[] {
  const r = rng(20261201);
  const [OAK, LA, SAC] = o.locations;
  const orders: OrderRec[] = [];
  for (let d = YEAR_DAYS; d > CORE_HISTORY_DAYS; d--) {
    const day = new Date(o.today - d * DAY_MS);
    const dow = day.getUTCDay();
    const weekday = dow === 5 || dow === 6 ? 1.2 : dow === 0 ? 0.6 : 1;
    const season = seasonality(day);
    const n = r.int(2, 4);
    const dayOrders: OrderRec[] = [];
    for (let i = 0; i < n; i++) {
      const at = new Date(day.getTime() + r.int(8, 18) * 3_600_000).toISOString();
      const status: OrderStatus = r.next() < 0.03 ? 'CANCELED' : 'COMPLETED';
      const customerId = r.pick(o.customerIds);
      const locationId = r.pick([OAK, OAK, LA, SAC]);
      dayOrders.push({
        id: r.uuid(),
        order_number: '',
        status,
        company_id: customerId,
        location_id: locationId,
        billing_location_id: o.customerLoc.get(customerId)!,
        shipping_location_id: o.customerLoc.get(customerId)!,
        order_datetime: at,
        due_datetime: new Date(Date.parse(at) + 30 * DAY_MS).toISOString(),
        delivery_datetime: new Date(Date.parse(at) + 2 * DAY_MS).toISOString(),
        delivered_datetime: status === 'COMPLETED' ? new Date(Date.parse(at) + 2 * DAY_MS).toISOString() : null,
        internal_notes: null,
        external_notes: null,
        items: [],
        charges: [],
        inserted_datetime: at,
        updated_datetime: new Date(Date.parse(at) + 2 * DAY_MS).toISOString(),
      });
    }
    for (const p of o.products) {
      let rate = (o.demandBySku.get(p.sku) ?? 0) * weekday * season;
      // the discontinued SKU was winding down before it stopped selling (85 days ago)
      if (p.sku === o.inactiveSku) rate *= d > 240 ? 1 : 0.7;
      const q = r.poisson(rate);
      const order = r.pick(dayOrders);
      if (q <= 0) continue;
      const item: OrderItemRec = {
        id: r.uuid(),
        product_id: p.id,
        batch_id: null,
        package_id: null,
        location_id: order.location_id,
        quantity: q,
        price: p.unit_price,
        price_base: p.unit_price,
        is_sample: false,
        note: null,
        inserted_datetime: order.order_datetime,
      };
      order.items.push(item);
    }
    orders.push(...dayOrders.filter((x) => x.items.length));
  }
  // SO numbers count up to the core seed's first (SO-1001), oldest first
  orders.sort((a, b) => (a.order_datetime === b.order_datetime ? a.id.localeCompare(b.id) : a.order_datetime < b.order_datetime ? -1 : 1));
  const first = 1001 - orders.length;
  orders.forEach((x, i) => {
    x.order_number = `SO-${first + i}`;
    o.store.orders.set(x.id, x);
  });
  return orders;
}

export type VendorKey = 'HHF' | 'ETG' | 'SEC' | 'GSE' | 'CCV' | 'MPR';

/** One price increase per vendor, on its most recent completed PO. */
export const PRICE_INCREASE: Record<VendorKey, number> = { HHF: 0.04, ETG: 0.05, SEC: 0.08, GSE: 0.06, CCV: 0.07, MPR: 0.05 };

/** Receipt variation per vendor (applied with `poVariation`): late receipts, short shipments, max delay. */
export const RECEIPT_VARIATION: Record<VendorKey, { late: number; short: number; maxDelay: number }> = {
  HHF: { late: 1, short: 2, maxDelay: 5 },
  ETG: { late: 2, short: 1, maxDelay: 7 },
  SEC: { late: 3, short: 2, maxDelay: 12 }, // extraction-line trouble
  GSE: { late: 2, short: 2, maxDelay: 9 }, // cacao and packaging shortages
  CCV: { late: 2, short: 1, maxDelay: 6 },
  MPR: { late: 2, short: 2, maxDelay: 6 },
};

export interface OlderPurchasesInput {
  store: Store;
  products: ProductRec[];
  demandBySku: ReadonlyMap<string, number>;
  vendorIds: Readonly<Record<VendorKey, string>>;
  oakland: string;
  today: number;
  /** apply RECEIPT_VARIATION (late / short receipts) */
  variation: boolean;
}

export interface OlderPurchase {
  po: PurchaseRec;
  vendor: VendorKey;
  lateByDays: number;
  shortLines: number;
}

/** 5–9 completed POs per vendor between ~4 and ~12 months ago. Returns them oldest first (already in the store). */
export function seedOlderPurchases(o: OlderPurchasesInput): OlderPurchase[] {
  const r = rng(20261202);
  const at = (d: number, hour: number) => new Date(o.today - d * DAY_MS + hour * 3_600_000).toISOString();
  const out: OlderPurchase[] = [];
  (Object.keys(o.vendorIds) as VendorKey[]).forEach((key, vi) => {
    const vendor = o.store.companies.get(o.vendorIds[key])!;
    const lead = vendor.lead_time_days;
    const vProducts = o.products.filter((p) => p.vendor_id === vendor.id);
    const n = r.int(5, 9);
    // the core seed's oldest PO for this vendor was ordered 110 + vi + lead days ago
    const newest = 110 + vi + lead + 18;
    const oldest = 362;
    const spacing = (oldest - newest) / n;
    const plan = RECEIPT_VARIATION[key];
    const lateSet = pickDistinct(r, n, plan.late);
    const shortSet = pickDistinct(r, n, plan.short);
    for (let k = 0; k < n; k++) {
      const orderedAgo = Math.round(oldest - k * spacing - r.int(0, Math.max(0, Math.floor(spacing * 0.3))));
      const delay = r.int(3, plan.maxDelay);
      const late = o.variation && lateSet.has(k) ? delay : 0;
      const receivedAgo = orderedAgo - lead - late;
      const shortLineIdx = r.int(0, Math.max(0, vProducts.length - 1));
      const shortShare = 0.55 + r.next() * 0.3;
      const items: PurchaseItemRec[] = vProducts.map((p) => {
        const perCase = p.units_per_case ?? 1;
        const demand = o.demandBySku.get(p.sku) ?? 1;
        const qty = Math.max(perCase, Math.ceil((demand * spacing * (0.95 + r.next() * 0.2)) / perCase) * perCase);
        return {
          id: r.uuid(),
          product_id: p.id,
          batch_id: null,
          package_id: null,
          location_id: o.oakland,
          quantity: qty,
          price: Math.round(p.unit_cost * (0.98 + r.next() * 0.04) * 100) / 100,
          received_quantity: qty,
        };
      });
      let shortLines = 0;
      if (o.variation && shortSet.has(k) && items.length) {
        // one or two lines arrive short (the second only for vendors with many SKUs)
        for (const idx of new Set([shortLineIdx, items.length > 4 ? (shortLineIdx + 2) % items.length : shortLineIdx])) {
          const it = items[idx]!;
          it.received_quantity = Math.max(1, Math.floor(it.quantity * shortShare));
          shortLines++;
        }
      }
      const hasCharge = r.next() < 0.5;
      const po: PurchaseRec = {
        id: r.uuid(),
        purchase_number: '',
        status: 'COMPLETED',
        company_id: vendor.id,
        location_id: o.oakland,
        billing_location_id: o.oakland,
        supplier_location_id: vendor.location_ids[0]!,
        order_datetime: at(orderedAgo, 10),
        due_datetime: at(orderedAgo - 30, 10),
        description: `Restock from ${vendor.name}`,
        owner_id: null,
        metrc_transfer_id: null,
        items,
        charges: hasCharge ? [{ id: r.uuid(), name: 'Delivery Fee', type: 'CHARGE', unit_type: 'PRICE', price: 75, percent: null, inserted_datetime: at(orderedAgo, 10) }] : [],
        custom_data: {},
        inserted_datetime: at(orderedAgo, 10),
        updated_datetime: at(receivedAgo, 15),
      };
      out.push({ po, vendor: key, lateByDays: late, shortLines });
    }
  });
  out.sort((a, b) => (a.po.order_datetime! === b.po.order_datetime! ? a.po.id.localeCompare(b.po.id) : a.po.order_datetime! < b.po.order_datetime! ? -1 : 1));
  // PO numbers and Metrc transfer ids count up to the core seed's first (PO-501, transfer 70001), oldest first
  const firstPo = 501 - out.length;
  out.forEach(({ po }, i) => {
    po.purchase_number = `PO-${firstPo + i}`;
    po.metrc_transfer_id = 70001 - out.length + i;
    o.store.purchases.set(po.id, po);
  });
  return out;
}

function pickDistinct(r: ReturnType<typeof rng>, n: number, k: number): Set<number> {
  const out = new Set<number>();
  while (out.size < Math.min(k, n)) out.add(r.int(0, n - 1));
  return out;
}

/**
 * The vendor's most recent completed PO (the core seed's newest generation) is billed `PRICE_INCREASE`
 * above the previous one, and so are that generation's batches (their cost) and any open PO after it.
 */
export function applyPriceIncreases(o: {
  store: Store;
  vendorIds: Readonly<Record<VendorKey, string>>;
  /** vendor id → its core POs by generation (0 oldest … 2 newest) */
  corePos: ReadonlyMap<string, PurchaseRec[]>;
  openPos: readonly PurchaseRec[];
}): void {
  for (const key of Object.keys(o.vendorIds) as VendorKey[]) {
    const vendorId = o.vendorIds[key];
    const gens = o.corePos.get(vendorId) ?? [];
    const prev = gens.at(-2);
    const last = gens.at(-1);
    if (!prev || !last) continue;
    const inc = PRICE_INCREASE[key];
    const prevPrice = new Map(prev.items.map((i) => [i.product_id ?? (i.batch_id ? o.store.batches.get(i.batch_id)?.product_id : null), i.price]));
    const newPrice = new Map<string, number>();
    for (const it of last.items) {
      const pid = it.product_id ?? (it.batch_id ? o.store.batches.get(it.batch_id)?.product_id ?? null : null);
      const base = (pid ? prevPrice.get(pid) : undefined) ?? it.price;
      it.price = Math.round(base * (1 + inc) * 100) / 100;
      if (pid) newPrice.set(pid, it.price);
      const b: BatchRec | undefined = it.batch_id ? o.store.batches.get(it.batch_id) : undefined;
      if (b) b.unit_cost = it.price;
    }
    for (const po of o.openPos) {
      if (po.company_id !== vendorId || po.status === 'DRAFT') continue;
      for (const it of po.items) if (it.product_id && newPrice.has(it.product_id)) it.price = newPrice.get(it.product_id)!;
    }
  }
}
