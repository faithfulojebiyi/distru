/**
 * Helpers for the purchase-order upsert (`POST /public/v1/purchases`).
 *
 * Distru semantics: `id` absent → create, present → update. Updates are sparse (omitted fields are
 * untouched, `null` clears). Sending `items` replaces the whole set: existing lines whose `id` you
 * omit are deleted, `{ id }` alone keeps a line, a line without `id` is added.
 */
import type { DistruClient } from './client';
import type { Purchase, PurchaseItemRequest, UpsertPurchaseBody, UpsertPurchaseBodyStatus } from './generated/model';

export interface PurchaseLineInput {
  /** For product- or package-tracked products. */
  productId?: string;
  /** For batch-tracked products (receive into this batch). */
  batchId?: string;
  quantity: number;
  /** Price per unit, in company currency. */
  unitPrice: number;
}

export interface NewPurchaseOrderInput {
  vendorId: string;
  /** Receiving location; copied onto every line (Distru requires it per line). */
  locationId: string;
  /** Defaults to `locationId`. */
  billingLocationId?: string;
  supplierLocationId?: string;
  lines: PurchaseLineInput[];
  /** Default PENDING (a real, un-received PO). */
  status?: UpsertPurchaseBodyStatus;
  orderDatetime?: Date | string;
  /** Explicit due date, or computed from `paymentTermDays` (default 30). */
  dueDatetime?: Date | string;
  paymentTermDays?: number;
  description?: string;
  /** Stamped into `description` so retries can detect an already-created PO. */
  idempotencyKey?: string;
}

const iso = (d: Date | string) => (typeof d === 'string' ? d : d.toISOString().replace(/\.\d{3}Z$/, 'Z'));

const IDEMPOTENCY_RE = /\[ops-agent:idem=([A-Za-z0-9._:-]+)\]/;

/** `[ops-agent:idem=<key>]` — the marker stored in the PO description (Distru has no idempotency header). */
export function idempotencyMarker(key: string): string {
  if (!/^[A-Za-z0-9._:-]+$/.test(key)) throw new Error(`invalid idempotency key: ${key}`);
  return `[ops-agent:idem=${key}]`;
}

export function extractIdempotencyKey(description: string | null | undefined): string | undefined {
  return description ? IDEMPOTENCY_RE.exec(description)?.[1] : undefined;
}

function toItem(line: PurchaseLineInput, locationId: string): PurchaseItemRequest {
  if (!line.productId && !line.batchId) throw new Error('purchase line needs productId or batchId');
  return {
    ...(line.batchId ? { batch_id: line.batchId } : { product_id: line.productId }),
    location_id: locationId,
    quantity: line.quantity,
    price: line.unitPrice,
  };
}

/** Body for creating a purchase order (no `id`). */
export function buildPurchaseOrder(input: NewPurchaseOrderInput): UpsertPurchaseBody {
  if (!input.lines.length) throw new Error('a purchase order needs at least one line');
  const order = input.orderDatetime ? new Date(input.orderDatetime) : new Date();
  const due = input.dueDatetime
    ? new Date(input.dueDatetime)
    : new Date(order.getTime() + (input.paymentTermDays ?? 30) * 86_400_000);
  const description = [input.description, input.idempotencyKey ? idempotencyMarker(input.idempotencyKey) : undefined]
    .filter(Boolean)
    .join('\n');
  return {
    status: input.status ?? 'PENDING',
    company_id: input.vendorId,
    location_id: input.locationId,
    billing_location_id: input.billingLocationId ?? input.locationId,
    ...(input.supplierLocationId ? { supplier_location_id: input.supplierLocationId } : {}),
    order_datetime: iso(order),
    due_datetime: iso(due),
    ...(description ? { description } : {}),
    items: input.lines.map((l) => toItem(l, input.locationId)),
  };
}

/** Body for a sparse update of an existing purchase order. */
export function buildPurchaseUpdate(id: string, patch: Omit<UpsertPurchaseBody, 'id'>): UpsertPurchaseBody {
  return { ...patch, id };
}

/**
 * Items array that keeps every existing line unchanged (`{ id }`) and appends new ones — use it when
 * adding lines, since sending `items` replaces the whole set.
 */
export function keepExistingItemsAndAdd(existing: Purchase, add: PurchaseLineInput[], locationId: string): PurchaseItemRequest[] {
  return [...existing.items.map((i) => ({ id: i.id }) as PurchaseItemRequest), ...add.map((l) => toItem(l, locationId))];
}

export interface PurchaseMismatch {
  field: string;
  expected: unknown;
  actual: unknown;
}

const num = (v: unknown) => (v == null || v === '' ? undefined : Number(v));

/**
 * Read-after-write check: compares what we sent to what Distru stored. Only fields present in the
 * body are compared (sparse semantics). Line items are matched by position.
 */
export function verifyPurchase(sent: UpsertPurchaseBody, stored: Purchase): PurchaseMismatch[] {
  const out: PurchaseMismatch[] = [];
  const cmp = (field: string, expected: unknown, actual: unknown) => {
    if (expected !== undefined && expected !== actual) out.push({ field, expected, actual });
  };
  if (sent.id) cmp('id', sent.id, stored.id);
  cmp('status', sent.status, stored.status);
  cmp('company_id', sent.company_id, stored.company?.id);
  cmp('location_id', sent.location_id, stored.location?.id);
  cmp('billing_location_id', sent.billing_location_id, stored.billing_location?.id);
  cmp('description', sent.description, stored.description);
  if (sent.items) {
    if (sent.items.length !== stored.items.length) {
      out.push({ field: 'items.length', expected: sent.items.length, actual: stored.items.length });
    }
    sent.items.forEach((item, i) => {
      const got = stored.items[i];
      if (!got) return;
      if (item.id) cmp(`items.${i}.id`, item.id, got.id);
      if (item.product_id) cmp(`items.${i}.product_id`, item.product_id, got.product?.id);
      if (item.batch_id) cmp(`items.${i}.batch_id`, item.batch_id, got.batch?.id);
      if (item.quantity != null) cmp(`items.${i}.quantity`, num(item.quantity), num(got.quantity));
      if (item.price != null) cmp(`items.${i}.price`, num(item.price), num(got.price));
    });
  }
  return out;
}

/** Upsert, then `GET /purchases/{id}` and verify. Throws `DistruApiError` on API errors. */
export async function upsertPurchaseVerified(client: DistruClient, body: UpsertPurchaseBody) {
  const { data: written } = await client.upsertPurchase(body);
  if (!written?.id) throw new Error('upsertPurchase returned no purchase id');
  const { data: stored } = await client.getPurchase(written.id);
  if (!stored) throw new Error(`getPurchase(${written.id}) returned no data`);
  return { purchase: stored, mismatches: verifyPurchase(body, stored), created: !body.id };
}

/** Looks for a purchase whose description carries the idempotency marker (all statuses incl. DRAFT). */
export async function findPurchaseByIdempotencyKey(
  client: DistruClient,
  key: string,
  filter: { companyId?: string } = {},
): Promise<Purchase | undefined> {
  const marker = idempotencyMarker(key);
  for await (const p of client.paginate(client.listPurchases, {
    statuses: ['DRAFT', 'PENDING', 'PROCESSING', 'DELIVERING', 'PARTIALLY_RECEIVED', 'COMPLETED'],
    ...(filter.companyId ? { company_ids: [filter.companyId] } : {}),
  })) {
    if (p.description?.includes(marker)) return p;
  }
  return undefined;
}
