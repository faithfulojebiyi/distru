/**
 * Distru REST records → unified rows. Lenient zod at the boundary (decimal strings → numbers,
 * unknown fields stripped). Free text (descriptions, notes) is deliberately NOT copied into the
 * context layer: it is untrusted and would end up in LLM prompts. The only free text read is the
 * vendor's default PO notes, and only to extract a promised lead time number.
 */
import { z } from 'zod';
import type { CompanyRelationship, CompanyRow, InventoryRow, OrderRow, ProductRow, PurchaseRow } from '../model';
import { toNum } from '../util';

export const DISTRU_SOURCE = 'distru';

const dec = z.union([z.string(), z.number()]).nullish().transform((v) => toNum(v));
const ref = z.object({ id: z.string() }).nullish();
const named = z.object({ name: z.string().nullish() }).nullish();
const dt = z.string().nullish().transform((v) => v ?? null);

export const DistruProductIn = z.object({
  id: z.string(),
  sku: z.string().nullish(),
  name: z.string(),
  category: named,
  vendor: ref,
  unit_cost: dec,
  unit_price: dec,
  units_per_case: dec,
  is_active: z.boolean().nullish(),
  updated_datetime: dt,
});

export const DistruCompanyIn = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string().nullish(),
  relationship_type: named,
  default_email: z.string().nullish(),
  purchase_order_email: z.string().nullish(),
  default_purchase_order_notes: z.string().nullish(),
  custom_data: z.array(z.object({ name: z.string().nullish(), value: z.unknown() })).nullish(),
  updated_datetime: dt,
});

const productRef = z.object({ id: z.string() }).nullish();

export const DistruPurchaseIn = z.object({
  id: z.string(),
  purchase_number: z.string().nullish(),
  status: z.string(),
  company: ref,
  location: ref,
  order_datetime: dt,
  total: dec,
  items: z
    .array(
      z.object({
        id: z.string(),
        product: productRef,
        quantity: dec,
        received_quantity: dec,
        price: dec,
      }),
    )
    .nullish(),
  updated_datetime: dt,
});

export const DistruOrderIn = z.object({
  id: z.string(),
  order_number: z.string().nullish(),
  status: z.string(),
  company: ref,
  location: ref,
  order_datetime: dt,
  delivered_datetime: dt,
  total: dec,
  items: z
    .array(
      z.object({
        id: z.string(),
        product: productRef,
        location: ref,
        quantity: dec,
        price: dec,
      }),
    )
    .nullish(),
  updated_datetime: dt,
});

export const DistruInventoryIn = z.object({
  product_id: z.string(),
  location_id: z.string().nullish(),
  active: dec,
  reserved: dec,
  available: dec,
});

export const DistruDeletedIn = z.object({ record_id: z.string(), record_type: z.string(), deleted_datetime: z.string() });

/** `Standard lead time 7 days`, `lead time: 10 business days`, `LT 14d` → days. */
export function parseLeadTimeDays(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = /lead[\s-]*time[^0-9]{0,20}(\d{1,3})\s*(?:business\s+|calendar\s+)?(?:d\b|days?)/i.exec(text) ?? /\bLT\s*(\d{1,3})\s*d\b/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 && n <= 365 ? n : null;
}

export function relationshipOf(name: string | null | undefined): CompanyRelationship {
  const n = (name ?? '').toLowerCase();
  if (/vendor|supplier|cultivator|manufacturer/.test(n)) return 'vendor';
  if (/customer|retail|dispensar|buyer/.test(n)) return 'customer';
  return 'other';
}

export function normalizeProduct(raw: unknown, syncedAt: string): ProductRow {
  const p = DistruProductIn.parse(raw);
  return {
    source: DISTRU_SOURCE,
    sourceId: p.id,
    sku: p.sku ?? null,
    name: p.name,
    category: p.category?.name ?? null,
    vendorId: p.vendor?.id ?? null,
    unitCost: p.unit_cost,
    unitPrice: p.unit_price,
    unitsPerCase: p.units_per_case,
    isActive: p.is_active ?? true,
    sourceUpdatedAt: p.updated_datetime,
    syncedAt,
    deletedAt: null,
  };
}

export function normalizeCompany(raw: unknown, syncedAt: string): CompanyRow {
  const c = DistruCompanyIn.parse(raw);
  // A "Lead time (days)" custom field wins over the notes.
  const customLead = (c.custom_data ?? []).find((f) => /lead\s*time/i.test(f.name ?? ''));
  const promised = toNum(customLead?.value) ?? parseLeadTimeDays(c.default_purchase_order_notes);
  return {
    source: DISTRU_SOURCE,
    sourceId: c.id,
    name: c.name,
    relationship: relationshipOf(c.relationship_type?.name),
    category: c.category ?? null,
    email: c.purchase_order_email ?? c.default_email ?? null,
    promisedLeadTimeDays: promised,
    sourceUpdatedAt: c.updated_datetime,
    syncedAt,
    deletedAt: null,
  };
}

/**
 * `receivedAt`: Distru has no receipt timestamp on a purchase. When we see a purchase move into
 * COMPLETED we record its `updated_datetime` (`observed`); a purchase that is already COMPLETED the
 * first time we see it gets its `updated_datetime` as an estimate. An existing value is kept.
 */
export function normalizePurchase(raw: unknown, syncedAt: string, previous: PurchaseRow | null): PurchaseRow {
  const p = DistruPurchaseIn.parse(raw);
  let receivedAt = previous?.receivedAt ?? null;
  let receivedAtSource = previous?.receivedAtSource ?? null;
  if (p.status === 'COMPLETED' && !receivedAt) {
    receivedAt = p.updated_datetime ?? syncedAt;
    receivedAtSource = previous && previous.status !== 'COMPLETED' ? 'observed' : 'updated_datetime';
  }
  return {
    source: DISTRU_SOURCE,
    sourceId: p.id,
    number: p.purchase_number ?? null,
    status: p.status,
    vendorId: p.company?.id ?? null,
    locationId: p.location?.id ?? null,
    orderedAt: p.order_datetime,
    receivedAt,
    receivedAtSource,
    total: p.total,
    lines: (p.items ?? []).map((i) => ({
      lineId: i.id,
      productId: i.product?.id ?? null,
      quantity: i.quantity ?? 0,
      receivedQuantity: i.received_quantity ?? 0,
      unitPrice: i.price,
    })),
    sourceUpdatedAt: p.updated_datetime,
    syncedAt,
    deletedAt: null,
  };
}

export function normalizeOrder(raw: unknown, syncedAt: string): OrderRow {
  const o = DistruOrderIn.parse(raw);
  return {
    source: DISTRU_SOURCE,
    sourceId: o.id,
    number: o.order_number ?? null,
    status: o.status,
    customerId: o.company?.id ?? null,
    locationId: o.location?.id ?? null,
    orderedAt: o.order_datetime,
    deliveredAt: o.delivered_datetime,
    total: o.total,
    lines: (o.items ?? []).map((i) => ({
      lineId: i.id,
      productId: i.product?.id ?? null,
      locationId: i.location?.id ?? null,
      quantity: i.quantity ?? 0,
      unitPrice: i.price,
    })),
    sourceUpdatedAt: o.updated_datetime,
    syncedAt,
    deletedAt: null,
  };
}

export function normalizeInventory(raw: unknown): InventoryRow {
  const r = DistruInventoryIn.parse(raw);
  return { productId: r.product_id, locationId: r.location_id ?? '', active: r.active ?? 0, reserved: r.reserved ?? 0, available: r.available ?? 0 };
}
