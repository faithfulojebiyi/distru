/**
 * GET /reports/inventory-velocity — computed the way Distru's docs describe it:
 * - sales windows end yesterday (UTC here); canceled orders are excluded
 * - demand rate = ½·avg30 + ½·avg365 (never below 0)
 * - reorder point = max(service-level percentile of past lead-time-long demand, alert min + rate·lead time)
 * - suggested qty = reorder point + target days of demand − available − incoming, rounded up to cases
 */
import type { InventoryVelocityReport, InventoryVelocityReportColumn, InventoryVelocityReportRow } from '@ops/distru-client/model';
import type { Store } from './store';
import { fmtDateMDY, fmtNum } from './util';

const DAY = 86_400_000;
export const dayIndex = (d: Date | string) => Math.floor(new Date(d).getTime() / DAY);

export interface VelocityParams {
  lead_time_days?: number;
  target_days_of_supply?: number;
  service_level?: number;
  no_sales_after_days?: number;
  stale_incoming_days?: number;
  search?: string;
  product_ids?: string[];
  location_ids?: string[];
  statuses?: string[];
  below_reorder_point?: boolean;
  below_quantity_available_threshold_min?: boolean;
  max_days_of_supply?: number;
  product_category_ids?: string[];
  vendor_ids?: string[];
  brand_ids?: string[];
  product_subcategory_ids?: string[];
  product_tag_ids?: string[];
  product_group_ids?: string[];
}

export interface ProductSales {
  /** index 0 = yesterday, 364 = 365 days ago */
  daily: Float64Array;
  orderIds: Set<string>;
  firstSaleAgo: number | null;
  lastSaleAgo: number | null;
}

/** Daily net sales for every product over the 365 days ending yesterday. */
export function salesByProduct(store: Store, opts: { statuses?: string[]; locationIds?: string[] } = {}): Map<string, ProductSales> {
  const today = dayIndex(store.now);
  const out = new Map<string, ProductSales>();
  for (const o of store.orders.values()) {
    if (opts.statuses?.length ? !opts.statuses.includes(o.status) : o.status === 'CANCELED') continue;
    const ago = today - dayIndex(o.order_datetime) - 1;
    if (ago < 0 || ago >= 365) continue;
    for (const item of o.items) {
      if (opts.locationIds?.length && !opts.locationIds.includes(item.location_id)) continue;
      let s = out.get(item.product_id);
      if (!s) {
        s = { daily: new Float64Array(365), orderIds: new Set(), firstSaleAgo: null, lastSaleAgo: null };
        out.set(item.product_id, s);
      }
      s.daily[ago]! += item.quantity;
      s.orderIds.add(o.id);
    }
  }
  for (const s of out.values()) {
    for (let i = 0; i < 365; i++) {
      if (s.daily[i]! > 0) {
        if (s.lastSaleAgo === null) s.lastSaleAgo = i;
        s.firstSaleAgo = i;
      }
    }
  }
  return out;
}

const sum = (a: Float64Array, days: number) => {
  let s = 0;
  for (let i = 0; i < days; i++) s += a[i]!;
  return s;
};

export function demandRate(s: ProductSales): number {
  return Math.max(0, 0.5 * (sum(s.daily, 30) / 30) + 0.5 * (sum(s.daily, 365) / 365));
}

/** Service-level percentile of rolling `lead`-day demand over the product's sales history. */
export function percentileLeadDemand(s: ProductSales, lead: number, serviceLevel: number): number {
  const history = Math.max(lead, Math.min(365, (s.firstSaleAgo ?? 0) + 1));
  const sums: number[] = [];
  let w = 0;
  for (let i = 0; i < history; i++) {
    w += s.daily[i] ?? 0;
    if (i >= lead) w -= s.daily[i - lead] ?? 0;
    if (i >= lead - 1) sums.push(w);
  }
  if (!sums.length) return 0;
  sums.sort((a, b) => a - b);
  const rank = Math.min(sums.length - 1, Math.max(0, Math.ceil((serviceLevel / 100) * sums.length) - 1));
  return sums[rank]!;
}

export function reorderPoint(
  s: ProductSales,
  lead: number,
  serviceLevel: number,
  thresholdMin: number | null,
): { value: number; source: 'CALCULATED' | 'MIN' } | null {
  const rate = demandRate(s);
  if (rate <= 0) return null;
  const calc = percentileLeadDemand(s, lead, serviceLevel);
  const min = thresholdMin != null ? thresholdMin + rate * lead : -Infinity;
  return min > calc ? { value: Math.ceil(min), source: 'MIN' } : { value: Math.ceil(calc), source: 'CALCULATED' };
}

const roundUpCases = (qty: number, perCase: number | null) =>
  perCase && perCase > 0 ? Math.ceil(qty / perCase) * perCase : Math.ceil(qty);

const COLUMN_LABELS: [keyof InventoryVelocityReportRow, string][] = [
  ['name', 'Product'],
  ['product_id', 'Product ID'],
  ['sku', 'SKU'],
  ['unit_type', 'Unit Type'],
  ['category', 'Category'],
  ['product_category_id', 'Product Category ID'],
  ['vendor', 'Vendor'],
  ['vendor_id', 'Vendor ID'],
  ['brand', 'Brand'],
  ['brand_id', 'Brand ID'],
  ['quantity_sold_30', 'Sold (30d)'],
  ['average_daily_sold_30', 'Avg Daily (30d)'],
  ['quantity_sold_60', 'Sold (60d)'],
  ['average_daily_sold_60', 'Avg Daily (60d)'],
  ['quantity_sold_90', 'Sold (90d)'],
  ['average_daily_sold_90', 'Avg Daily (90d)'],
  ['quantity_sold_120', 'Sold (120d)'],
  ['average_daily_sold_120', 'Avg Daily (120d)'],
  ['quantity_sold_180', 'Sold (180d)'],
  ['average_daily_sold_180', 'Avg Daily (180d)'],
  ['quantity_sold_365', 'Sold (365d)'],
  ['average_daily_sold_365', 'Avg Daily (365d)'],
  ['average_daily_sold', 'Demand Rate'],
  ['distinct_orders', 'Orders'],
  ['last_sold_at', 'Last Sold'],
  ['confidence', 'Confidence'],
  ['confidence_reasons', 'Confidence Reasons'],
  ['quantity_available', 'Available'],
  ['quantity_incoming', 'Incoming'],
  ['stale_incoming_quantity', 'Stale Incoming'],
  ['days_of_supply', 'Days of Supply'],
  ['days_of_supply_with_incoming', 'Days of Supply (w/ Incoming)'],
  ['estimated_stockout_date', 'Est. Stockout'],
  ['quantity_available_threshold_min', 'Alert Min'],
  ['quantity_available_threshold_max', 'Alert Max'],
  ['below_quantity_available_threshold_min', 'Below Alert Min'],
  ['lead_time_days', 'Lead Time (days)'],
  ['service_level', 'Service Level'],
  ['reorder_point', 'Reorder Point'],
  ['reorder_point_source', 'Reorder Point Source'],
  ['below_reorder_point', 'Below Reorder Point'],
  ['reorder_by_date', 'Reorder By'],
  ['reorder_status', 'Reorder Status'],
  ['units_per_case', 'Units / Case'],
  ['suggested_order_quantity', 'Suggested Qty'],
  ['suggested_order_quantity_at_reorder_date', 'Suggested Qty at Reorder Date'],
  ['suggested_cases', 'Suggested Cases'],
];

export function inventoryVelocityReport(store: Store, p: VelocityParams): InventoryVelocityReport {
  const target = p.target_days_of_supply ?? 30;
  const serviceLevel = p.service_level ?? 95;
  const noSalesAfter = p.no_sales_after_days ?? 60;
  const staleDays = p.stale_incoming_days ?? 90;
  const lead = p.lead_time_days;
  const today = new Date(dayIndex(store.now) * DAY);
  const staleCutoff = new Date(today.getTime() - staleDays * DAY);
  const sales = salesByProduct(store, { statuses: p.statuses, locationIds: p.location_ids });
  const search = p.search?.toLowerCase();

  const rows: InventoryVelocityReportRow[] = [];
  for (const prod of store.products.values()) {
    if (!prod.is_active) continue;
    const s = sales.get(prod.id);
    if (!s || s.lastSaleAgo === null) continue;
    if (p.product_ids?.length && !p.product_ids.includes(prod.id)) continue;
    if (p.vendor_ids?.length && !p.vendor_ids.includes(prod.vendor_id)) continue;
    if (p.product_category_ids?.length && !p.product_category_ids.includes(prod.category_id)) continue;
    // the mock has no brands, tags, groups or subcategories: those filters match nothing
    if (p.brand_ids?.length || p.product_tag_ids?.length || p.product_group_ids?.length || p.product_subcategory_ids?.length) continue;
    const vendor = store.companies.get(prod.vendor_id);
    const category = store.categories.get(prod.category_id);
    if (search && !prod.name.toLowerCase().includes(search) && !prod.sku.toLowerCase().includes(search) && !vendor?.name.toLowerCase().includes(search)) continue;

    const available = store.quantityActive(prod.id, p.location_ids) - store.quantityReserved(prod.id, p.location_ids);
    const incoming = store.quantityIncoming(prod.id, { newerThan: staleCutoff, locationIds: p.location_ids });
    const staleIncoming = store.quantityIncoming(prod.id, { olderThan: staleCutoff, locationIds: p.location_ids });
    const rate = demandRate(s);
    const windows = [30, 60, 90, 120, 180, 365] as const;
    const sold = Object.fromEntries(windows.map((w) => [w, sum(s.daily, w)])) as Record<(typeof windows)[number], number>;
    const avg = (w: (typeof windows)[number]) => sold[w] / w;

    const daysWithSale = s.daily.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
    const reasons: string[] = [];
    if (s.orderIds.size < 5) reasons.push('Fewer than 5 orders in the last 365 days');
    if (daysWithSale < 5) reasons.push('Fewer than 5 days with a sale in the last 365 days');
    let confidence: 'LOW' | 'MEDIUM' | 'HIGH' = reasons.length ? 'LOW' : 'HIGH';
    if (confidence === 'HIGH') {
      const mids = [avg(30), avg(60), avg(90), avg(120), avg(180)];
      const ref = avg(90) || 1;
      if (s.orderIds.size < 12) reasons.push('Fewer than 12 orders in the last 365 days');
      if (mids.some((m) => Math.abs(m - ref) / ref > 0.35)) reasons.push('The 30 to 180 day averages disagree');
      if (s.lastSaleAgo >= noSalesAfter && noSalesAfter > 0) reasons.push(`No sale in the last ${noSalesAfter} days`);
      if (lead && (s.firstSaleAgo ?? 0) + 1 < lead) reasons.push('Less sales history than the lead time');
      if (reasons.length) confidence = 'MEDIUM';
    }

    const noRecentSales = noSalesAfter > 0 && s.lastSaleAgo >= noSalesAfter;
    const rop = lead && rate > 0 ? reorderPoint(s, lead, serviceLevel, prod.threshold_min) : null;
    let status: InventoryVelocityReportRow['reorder_status'] = 'UNKNOWN';
    let reorderBy: Date | null = null;
    let suggested: number | null = null;
    let suggestedAtReorder: number | null = null;
    if (lead && rate > 0 && rop) {
      const stock = available + incoming;
      const daysUntilRop = Math.max(0, Math.floor((stock - rop.value) / rate));
      reorderBy = new Date(today.getTime() + daysUntilRop * DAY);
      if (noRecentSales) {
        status = 'NO_RECENT_SALES';
        reorderBy = null;
      } else {
        if (stock / rate < lead) status = 'LATE';
        else if (daysUntilRop === 0) status = 'ORDER_NOW';
        else if (daysUntilRop <= 7) status = 'ORDER_SOON';
        else status = 'OK';
        suggested = roundUpCases(Math.max(0, rop.value + target * rate - available - incoming), prod.units_per_case);
        suggestedAtReorder = roundUpCases(target * rate, prod.units_per_case);
      }
    }
    const applies = status === 'LATE' || status === 'ORDER_NOW' ? suggested : suggestedAtReorder;
    const dos = rate > 0 ? available / rate : null;
    const row: InventoryVelocityReportRow = {
      name: prod.name,
      product_id: prod.id,
      sku: prod.sku,
      unit_type: 'Each',
      category: category?.name ?? '',
      product_category_id: prod.category_id,
      vendor: vendor?.name ?? '',
      vendor_id: prod.vendor_id,
      brand: null,
      brand_id: null,
      quantity_sold_30: fmtNum(sold[30]),
      average_daily_sold_30: fmtNum(avg(30)),
      quantity_sold_60: fmtNum(sold[60]),
      average_daily_sold_60: fmtNum(avg(60)),
      quantity_sold_90: fmtNum(sold[90]),
      average_daily_sold_90: fmtNum(avg(90)),
      quantity_sold_120: fmtNum(sold[120]),
      average_daily_sold_120: fmtNum(avg(120)),
      quantity_sold_180: fmtNum(sold[180]),
      average_daily_sold_180: fmtNum(avg(180)),
      quantity_sold_365: fmtNum(sold[365]),
      average_daily_sold_365: fmtNum(avg(365)),
      average_daily_sold: fmtNum(rate),
      distinct_orders: String(s.orderIds.size),
      last_sold_at: fmtDateMDY(new Date(today.getTime() - (s.lastSaleAgo + 1) * DAY)),
      confidence,
      confidence_reasons: reasons.length ? reasons.join('; ') : null,
      quantity_available: fmtNum(available),
      quantity_incoming: fmtNum(incoming),
      stale_incoming_quantity: fmtNum(staleIncoming),
      days_of_supply: dos === null ? null : dos.toFixed(1),
      days_of_supply_with_incoming: rate > 0 ? ((available + incoming) / rate).toFixed(1) : null,
      estimated_stockout_date: dos === null ? null : fmtDateMDY(new Date(today.getTime() + Math.max(0, Math.floor(dos)) * DAY)),
      quantity_available_threshold_min: prod.threshold_min == null ? null : fmtNum(prod.threshold_min),
      quantity_available_threshold_max: prod.threshold_max == null ? null : fmtNum(prod.threshold_max),
      below_quantity_available_threshold_min: prod.threshold_min == null ? null : available <= prod.threshold_min,
      lead_time_days: lead ? String(lead) : null,
      service_level: String(serviceLevel),
      reorder_point: rop ? fmtNum(rop.value) : null,
      reorder_point_source: rop ? rop.source : null,
      below_reorder_point: rop ? available <= rop.value : null,
      reorder_by_date: reorderBy ? fmtDateMDY(reorderBy) : null,
      reorder_status: status,
      units_per_case: prod.units_per_case == null ? null : String(prod.units_per_case),
      suggested_order_quantity: suggested === null ? null : fmtNum(suggested),
      suggested_order_quantity_at_reorder_date: suggestedAtReorder === null ? null : fmtNum(suggestedAtReorder),
      suggested_cases: applies !== null && prod.units_per_case ? fmtNum(Math.ceil(applies / prod.units_per_case)) : null,
    };

    if (p.below_reorder_point !== undefined && (row.below_reorder_point == null || row.below_reorder_point !== p.below_reorder_point)) continue;
    if (
      p.below_quantity_available_threshold_min !== undefined &&
      (row.below_quantity_available_threshold_min == null || row.below_quantity_available_threshold_min !== p.below_quantity_available_threshold_min)
    )
      continue;
    if (p.max_days_of_supply !== undefined && (dos === null || dos > p.max_days_of_supply)) continue;
    rows.push(Object.assign({ _reorderBy: reorderBy?.getTime() ?? Infinity }, row));
  }

  rows.sort((a, b) => {
    const ra = (a as { _reorderBy?: number })._reorderBy ?? Infinity;
    const rb = (b as { _reorderBy?: number })._reorderBy ?? Infinity;
    return ra === rb ? a.name.localeCompare(b.name) : ra - rb;
  });
  for (const r of rows) delete (r as { _reorderBy?: number })._reorderBy;

  const columns: InventoryVelocityReportColumn[] = COLUMN_LABELS.map(([key, label]) => ({ key, label }));
  const now = new Date();
  return {
    data: rows,
    meta: {
      report: 'inventory_velocity',
      date_range: `${fmtDateMDY(now)} ${now.toISOString().slice(11, 16)} UTC`,
      columns,
    },
  };
}
