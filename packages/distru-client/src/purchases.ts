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
  /**
   * Id of a TEXT purchase custom field (GET /custom-fields?parent_object=purchase) that holds the
   * idempotency key. When set with `idempotencyKey`, the key is also written to `custom_data`
   * (the description marker stays as a fallback).
   */
  idempotencyCustomFieldId?: number | string;
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
    ...(input.idempotencyKey && input.idempotencyCustomFieldId !== undefined ? { custom_data: { [String(input.idempotencyCustomFieldId)]: input.idempotencyKey } } : {}),
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
 * body are compared (sparse semantics).
 *
 * Line items are matched by line `id` when the sent line has one, otherwise by product (or batch for
 * batch-tracked lines) among the stored lines not matched yet — Distru does not promise to keep the
 * order we sent. Mismatch fields are named after the sent line's index (`items.<i>.quantity`); a sent
 * line with no stored counterpart is reported as `items.<i>` (actual `undefined`).
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
  if (sent.custom_data) {
    for (const [fieldId, value] of Object.entries(sent.custom_data)) {
      const got = stored.custom_data?.find((c) => String(c.id) === fieldId)?.value ?? null;
      const expected = value === null || value === '' ? null : Array.isArray(value) ? value.join(', ') : String(value);
      if (expected !== got && !(expected !== null && got !== null && Date.parse(expected) === Date.parse(got) && !Number.isNaN(Date.parse(expected)))) {
        out.push({ field: `custom_data.${fieldId}`, expected, actual: got });
      }
    }
  }
  if (sent.items) {
    if (sent.items.length !== stored.items.length) {
      out.push({ field: 'items.length', expected: sent.items.length, actual: stored.items.length });
    }
    const used = new Set<number>();
    const claim = (pred: (g: Purchase['items'][number]) => boolean) => {
      const idx = stored.items.findIndex((g, j) => !used.has(j) && pred(g));
      if (idx >= 0) used.add(idx);
      return idx >= 0 ? stored.items[idx] : undefined;
    };
    // pass 1: lines with an id; pass 2: the rest by product / batch
    const matches = new Map<number, Purchase['items'][number] | undefined>();
    sent.items.forEach((item, i) => {
      if (item.id) matches.set(i, claim((g) => g.id === item.id));
    });
    sent.items.forEach((item, i) => {
      if (item.id) return;
      if (item.batch_id) matches.set(i, claim((g) => g.batch?.id === item.batch_id));
      else if (item.product_id) matches.set(i, claim((g) => g.product?.id === item.product_id));
      else matches.set(i, undefined);
    });
    sent.items.forEach((item, i) => {
      const got = matches.get(i);
      if (!got) {
        out.push({ field: `items.${i}`, expected: item.id ?? item.batch_id ?? item.product_id ?? 'line', actual: undefined });
        return;
      }
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

/**
 * How far back `findPurchaseByIdempotencyKey` looks by default: just inside Distru's free list window
 * (a list call whose `updated_datetime` lower bound is within the last 30 days costs nothing against
 * the 3,000-call budget and is never refused). 10 minutes of margin absorb clock skew between us and
 * Distru, so the call stays free.
 */
export const IDEMPOTENCY_LOOKBACK_MS = 30 * 86_400_000 - 10 * 60_000;

export interface FindPurchaseByIdempotencyKeyOptions {
  companyId?: string;
  /**
   * Lower bound for `updated_datetime` (inclusive). Default: now − 30 days (+10 min margin), which
   * keeps the lookup free. Purchases last updated before it are not found, so pass an older bound
   * (and accept that the call costs one per page) to look further back.
   */
  since?: Date | string;
  /**
   * TEXT purchase custom field holding the key (see `buildPurchaseOrder({ idempotencyCustomFieldId })`).
   * A custom-field match wins over the description marker, which stays as the fallback.
   */
  idempotencyCustomFieldId?: number | string;
  /** Injected clock for the default `since` (tests). */
  now?: () => number;
}

/**
 * Looks for the purchase an earlier attempt created with this idempotency key: lists every status
 * (DRAFT included) with a free `updated_datetime` lower bound, preferring a purchase whose idempotency
 * custom field equals the key, else one whose description carries the `[ops-agent:idem=<key>]` marker.
 */
export async function findPurchaseByIdempotencyKey(
  client: DistruClient,
  key: string,
  filter: FindPurchaseByIdempotencyKeyOptions = {},
): Promise<Purchase | undefined> {
  const marker = idempotencyMarker(key);
  const now = filter.now?.() ?? Date.now();
  const since = filter.since !== undefined ? new Date(filter.since) : new Date(now - IDEMPOTENCY_LOOKBACK_MS);
  if (Number.isNaN(since.getTime())) throw new Error(`findPurchaseByIdempotencyKey: invalid since ${String(filter.since)}`);
  const fieldId = filter.idempotencyCustomFieldId !== undefined ? String(filter.idempotencyCustomFieldId) : undefined;
  let byMarker: Purchase | undefined;
  for await (const p of client.paginate(client.listPurchases, {
    statuses: ['DRAFT', 'PENDING', 'PROCESSING', 'DELIVERING', 'PARTIALLY_RECEIVED', 'COMPLETED'],
    updated_datetime: `${since.toISOString()},`,
    ...(filter.companyId ? { company_ids: [filter.companyId] } : {}),
  })) {
    if (fieldId !== undefined && p.custom_data?.some((c) => String(c.id) === fieldId && c.value === key)) return p;
    if (!byMarker && p.description?.includes(marker)) {
      byMarker = p;
      if (fieldId === undefined) return p;
    }
  }
  return byMarker;
}
