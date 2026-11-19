/**
 * POST /purchases and POST /orders with Distru's upsert semantics:
 * id absent → create, present → update (unknown id → 404); sparse updates (omitted = unchanged,
 * null = clear); sending `items`/`charges` replaces the set (omitted ids deleted, `{id}` alone keeps
 * a row, rows without id are added). Validation errors use the single error envelope with pointers.
 */
import type { Store } from './store';
import type { ChargeRec, OrderItemRec, OrderRec, OrderStatus, PurchaseItemRec, PurchaseRec, PurchaseStatus } from './types';

export interface ApiErrorItem {
  message: string;
  pointer: (string | number)[];
}
export type UpsertResult<T> = { ok: true; created: boolean; record: T; before: T | null } | { ok: false; status: 400 | 404; errors: ApiErrorItem[] };

const PURCHASE_STATUSES: PurchaseStatus[] = ['COMPLETED', 'DELIVERING', 'DRAFT', 'PENDING', 'PARTIALLY_RECEIVED', 'PROCESSING'];
const RECEIVED: PurchaseStatus[] = ['PARTIALLY_RECEIVED', 'COMPLETED'];
const ORDER_STATUSES: OrderStatus[] = ['PENDING', 'PROCESSING', 'READY_TO_SHIP', 'DELIVERING', 'DELIVERED', 'COMPLETED', 'CANCELED'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const ISO_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

class Errors {
  list: ApiErrorItem[] = [];
  add(pointer: (string | number)[], message: string) {
    this.list.push({ message, pointer });
  }
}

/** Validates and normalises a string-id field: undefined = omitted, null = clear. */
function idField(body: Record<string, unknown>, key: string, errs: Errors): string | null | undefined {
  if (!has(body, key)) return undefined;
  const v = body[key];
  if (v === null) return null;
  if (typeof v !== 'string' || v === '') {
    errs.add([key], 'is invalid');
    return undefined;
  }
  return v;
}

function dtField(body: Record<string, unknown>, key: string, errs: Errors): string | null | undefined {
  if (!has(body, key)) return undefined;
  const v = body[key];
  if (v === null) return null;
  if (typeof v !== 'string' || !ISO_DT.test(v) || Number.isNaN(Date.parse(v))) {
    errs.add([key], 'must be a full ISO8601 datetime, e.g. 2026-08-18T00:00:00Z');
    return undefined;
  }
  return new Date(v).toISOString();
}

function strField(body: Record<string, unknown>, key: string, errs: Errors): string | null | undefined {
  if (!has(body, key)) return undefined;
  const v = body[key];
  if (v === null || typeof v === 'string') return v;
  errs.add([key], 'must be a string');
  return undefined;
}

function numField(o: Record<string, unknown>, key: string, pointer: (string | number)[], errs: Errors): number | undefined {
  if (!has(o, key) || o[key] === undefined) return undefined;
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    errs.add(pointer, 'must be a number');
    return undefined;
  }
  return v;
}

function parseCharges(raw: unknown, existing: ChargeRec[], store: Store, errs: Errors): ChargeRec[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    errs.add(['charges'], 'must be a list');
    return undefined;
  }
  const out: ChargeRec[] = [];
  raw.forEach((c, i) => {
    const at = (k: string) => ['charges', i, k];
    if (!isObj(c)) return errs.add(['charges', i], 'must be an object');
    if (c.charge_preset_id != null) return errs.add(at('charge_preset_id'), 'does not exist');
    const prev = typeof c.id === 'string' ? existing.find((e) => e.id === c.id) : undefined;
    if (c.id != null && !prev) return errs.add(at('id'), 'does not exist on this record');
    const merged: ChargeRec = prev
      ? { ...prev }
      : { id: store.newId(), name: '', type: 'CHARGE', unit_type: 'PRICE', price: null, percent: null, inserted_datetime: store.nowIso() };
    if (has(c, 'name')) typeof c.name === 'string' && c.name ? (merged.name = c.name) : errs.add(at('name'), "can't be blank");
    if (has(c, 'type')) c.type === 'CHARGE' || c.type === 'DISCOUNT' ? (merged.type = c.type) : errs.add(at('type'), 'is invalid');
    if (has(c, 'unit_type')) c.unit_type === 'PERCENT' || c.unit_type === 'PRICE' ? (merged.unit_type = c.unit_type) : errs.add(at('unit_type'), 'is invalid');
    const price = numField(c, 'price', at('price'), errs);
    const percent = numField(c, 'percent', at('percent'), errs);
    if (price !== undefined) merged.price = price;
    if (percent !== undefined) merged.percent = percent;
    if (!prev) {
      if (!has(c, 'name')) errs.add(at('name'), "can't be blank");
      if (!has(c, 'type')) errs.add(at('type'), "can't be blank");
      if (!has(c, 'unit_type')) errs.add(at('unit_type'), "can't be blank");
    }
    if (merged.unit_type === 'PRICE' && merged.price == null) errs.add(at('price'), "can't be blank when unit_type is PRICE");
    if (merged.unit_type === 'PERCENT' && merged.percent == null) errs.add(at('percent'), "can't be blank when unit_type is PERCENT");
    out.push(merged);
  });
  return out;
}

export function upsertPurchase(store: Store, body: unknown): UpsertResult<PurchaseRec> {
  const errs = new Errors();
  if (!isObj(body)) return { ok: false, status: 400, errors: [{ message: 'Request body must be a JSON object', pointer: ['base'] }] };

  let existing: PurchaseRec | undefined;
  if (body.id != null) {
    if (typeof body.id !== 'string') return { ok: false, status: 400, errors: [{ message: 'is invalid', pointer: ['id'] }] };
    existing = store.purchases.get(body.id);
    if (!existing) return { ok: false, status: 404, errors: [{ message: 'Purchase not found', pointer: ['base'] }] };
  }
  const before = existing ? structuredClone(existing) : null;
  const wasDraft = existing?.status === 'DRAFT';

  // status
  let status: PurchaseStatus | undefined = existing?.status;
  if (has(body, 'status')) {
    if (typeof body.status !== 'string' || !PURCHASE_STATUSES.includes(body.status as PurchaseStatus)) {
      errs.add(['status'], `is invalid; must be one of ${PURCHASE_STATUSES.join(', ')}`);
    } else status = body.status as PurchaseStatus;
  } else if (!existing) errs.add(['status'], "can't be blank");
  if (existing && status && status !== existing.status) {
    if (status === 'DRAFT') errs.add(['status'], 'cannot move back to DRAFT');
    else if (RECEIVED.includes(existing.status) && !RECEIVED.includes(status)) {
      errs.add(['status'], `cannot move from ${existing.status} back to ${status}: the purchase has received inventory`);
    }
  }
  const isDraft = status === 'DRAFT';

  // top-level fields
  const company_id = idField(body, 'company_id', errs);
  const location_id = idField(body, 'location_id', errs);
  const billing_location_id = idField(body, 'billing_location_id', errs);
  const supplier_location_id = idField(body, 'supplier_location_id', errs);
  const owner_id = idField(body, 'owner_id', errs);
  const order_datetime = dtField(body, 'order_datetime', errs);
  const due_datetime = dtField(body, 'due_datetime', errs);
  const description = strField(body, 'description', errs);

  if (company_id && !store.companies.has(company_id)) errs.add(['company_id'], 'does not exist');
  for (const [k, v] of [['location_id', location_id], ['billing_location_id', billing_location_id]] as const) {
    if (v && !store.ownLocationIds.includes(v)) errs.add([k], 'does not exist or is not one of your locations');
  }
  if (owner_id) errs.add(['owner_id'], 'does not exist');
  if (existing && !wasDraft) {
    if (company_id !== undefined && existing.company_id && company_id !== existing.company_id) errs.add(['company_id'], 'cannot be changed once set');
    if (location_id !== undefined && existing.location_id && location_id !== existing.location_id) errs.add(['location_id'], 'cannot be changed once set');
  }
  if (has(body, 'metrc_transfer_id') && body.metrc_transfer_id != null) {
    if (status !== 'COMPLETED') errs.add(['metrc_transfer_id'], 'can only be set when status is COMPLETED');
    else errs.add(['metrc_transfer_id'], 'no incoming Metrc transfer with this id was found for your licenses');
  }
  if (has(body, 'biotrack_id') && body.biotrack_id != null) errs.add(['biotrack_id'], 'no incoming BioTrack transfer with this id was found');

  const next = {
    company_id: company_id !== undefined ? company_id : (existing?.company_id ?? null),
    location_id: location_id !== undefined ? location_id : (existing?.location_id ?? null),
    billing_location_id: billing_location_id !== undefined ? billing_location_id : (existing?.billing_location_id ?? null),
    supplier_location_id: supplier_location_id !== undefined ? supplier_location_id : (existing?.supplier_location_id ?? null),
    order_datetime: order_datetime !== undefined ? order_datetime : (existing?.order_datetime ?? null),
    due_datetime: due_datetime !== undefined ? due_datetime : (existing?.due_datetime ?? null),
  };
  if (next.supplier_location_id) {
    const loc = store.locations.get(next.supplier_location_id);
    if (!loc) errs.add(['supplier_location_id'], 'does not exist');
    else if (next.company_id && loc.company_id !== next.company_id) errs.add(['supplier_location_id'], "must be one of the supplier's locations");
  }
  if (!isDraft) {
    for (const k of ['company_id', 'location_id', 'billing_location_id', 'order_datetime', 'due_datetime'] as const) {
      if (!next[k] && !errs.list.some((e) => e.pointer[0] === k)) errs.add([k], "can't be blank");
    }
  }

  // items (replace-the-set semantics)
  let items: PurchaseItemRec[] | undefined;
  if (has(body, 'items')) {
    if (!Array.isArray(body.items)) errs.add(['items'], 'must be a list');
    else {
      const list: PurchaseItemRec[] = (items = []);
      body.items.forEach((raw, i) => {
        const at = (k: string) => ['items', i, k];
        if (!isObj(raw)) return errs.add(['items', i], 'must be an object');
        const prev = raw.id != null ? existing?.items.find((x) => x.id === raw.id) : undefined;
        if (raw.id != null && !prev) return errs.add(at('id'), 'does not exist on this purchase');
        const item: PurchaseItemRec = prev
          ? { ...prev }
          : { id: store.newId(), product_id: null, batch_id: null, package_id: null, location_id: null, quantity: NaN, price: NaN, received_quantity: 0 };
        if (has(raw, 'product_id')) {
          if (raw.product_id === null) item.product_id = null;
          else if (typeof raw.product_id !== 'string' || !store.products.has(raw.product_id)) errs.add(at('product_id'), 'does not exist');
          else item.product_id = raw.product_id;
        }
        if (has(raw, 'batch_id')) {
          if (raw.batch_id === null) item.batch_id = null;
          else if (typeof raw.batch_id !== 'string' || !store.batches.has(raw.batch_id)) errs.add(at('batch_id'), 'does not exist');
          else item.batch_id = raw.batch_id;
        }
        if (has(raw, 'location_id')) {
          if (typeof raw.location_id !== 'string' || !store.ownLocationIds.includes(raw.location_id)) errs.add(at('location_id'), 'does not exist or is not one of your locations');
          else item.location_id = raw.location_id;
        }
        const q = numField(raw, 'quantity', at('quantity'), errs);
        const price = numField(raw, 'price', at('price'), errs);
        const rq = numField(raw, 'received_quantity', at('received_quantity'), errs);
        if (q !== undefined) item.quantity = q;
        if (price !== undefined) item.price = price;
        if (!prev) {
          if (!has(raw, 'quantity')) errs.add(at('quantity'), "can't be blank");
          if (!has(raw, 'price')) errs.add(at('price'), "can't be blank");
        }
        if (q !== undefined && q <= 0) errs.add(at('quantity'), 'must be greater than 0');
        if (price !== undefined && price < 0) errs.add(at('price'), 'must be greater than or equal to 0');

        const product = item.product_id ? store.products.get(item.product_id) : item.batch_id ? store.products.get(store.batches.get(item.batch_id)?.product_id ?? '') : undefined;
        if (item.batch_id && item.product_id && store.batches.get(item.batch_id)?.product_id !== item.product_id) errs.add(at('batch_id'), "must be a batch of the line's product");
        if (!prev && !isDraft && !item.product_id && !item.batch_id) errs.add(['items', i], 'must declare its product: product_id (or batch_id for a batch-tracked product)');
        if (product && !isDraft) {
          if (product.tracking === 'BATCH' && !item.batch_id) errs.add(at('batch_id'), "can't be blank for a batch-tracked product");
          if (product.tracking !== 'BATCH' && item.batch_id) errs.add(at('batch_id'), `must be empty for a ${product.tracking.toLowerCase()}-tracked product`);
        }
        if (!isDraft) {
          if (!item.location_id) errs.add(at('location_id'), "can't be blank");
          else if (next.location_id && item.location_id !== next.location_id) errs.add(at('location_id'), "must be the purchase's location_id");
        }
        if (rq !== undefined) {
          if (status !== 'PARTIALLY_RECEIVED') errs.add(at('received_quantity'), 'can only be set when status is PARTIALLY_RECEIVED');
          else if (rq < 0 || rq > item.quantity) errs.add(at('received_quantity'), 'must be between 0 and quantity');
          else item.received_quantity = rq;
        }
        list.push(item);
      });
    }
  }
  const finalItems = items ?? existing?.items ?? [];
  if (!isDraft && finalItems.length === 0 && !errs.list.some((e) => e.pointer[0] === 'items')) errs.add(['items'], 'must contain at least one line item');
  if (!isDraft && !items && existing && status !== existing.status) {
    // finishing a draft / changing status re-validates stored lines against the new rules
    finalItems.forEach((it, i) => {
      if (!it.product_id && !it.batch_id) errs.add(['items', i], 'must declare its product');
      if (!it.location_id || it.location_id !== next.location_id) errs.add(['items', i, 'location_id'], "must be the purchase's location_id");
    });
  }
  const tracking = finalItems.map((it) => {
    const pid = it.product_id ?? (it.batch_id ? store.batches.get(it.batch_id)?.product_id : undefined);
    return pid ? store.products.get(pid)?.tracking : undefined;
  });
  const hasPackage = tracking.includes('PACKAGE');
  if (!isDraft && hasPackage && tracking.some((t) => t && t !== 'PACKAGE')) {
    errs.add(['items'], 'line items must be either all package-tracked or all not package-tracked');
  }
  if (status === 'PARTIALLY_RECEIVED' && hasPackage) errs.add(['status'], 'PARTIALLY_RECEIVED is not supported for purchases with package-tracked items');
  if (status === 'COMPLETED' && hasPackage && !(existing?.metrc_transfer_id)) {
    if (!errs.list.some((e) => e.pointer[0] === 'metrc_transfer_id')) {
      errs.add(['status'], 'a purchase with package-tracked items must be matched with an incoming compliance transfer (metrc_transfer_id) to be COMPLETED');
    }
  }
  if (existing?.metrc_transfer_id && status !== 'COMPLETED') errs.add(['status'], 'is locked at COMPLETED once matched with a compliance transfer');

  const charges = parseCharges(body.charges, existing?.charges ?? [], store, errs);

  if (errs.list.length) return { ok: false, status: 400, errors: errs.list };

  const now = store.nowIso();
  const rec: PurchaseRec = existing ?? {
    id: store.newId(),
    purchase_number: `PO-${++store.counters.purchase}`,
    status: status!,
    company_id: null,
    location_id: null,
    billing_location_id: null,
    supplier_location_id: null,
    order_datetime: null,
    due_datetime: null,
    description: null,
    owner_id: null,
    metrc_transfer_id: null,
    items: [],
    charges: [],
    custom_data: {},
    inserted_datetime: now,
    updated_datetime: now,
  };
  Object.assign(rec, next);
  rec.status = status!;
  if (description !== undefined) rec.description = description;
  if (items) rec.items = items;
  if (charges) rec.charges = charges;
  if (isObj(body.custom_data)) Object.assign(rec.custom_data, body.custom_data);
  rec.updated_datetime = now;

  // receiving: COMPLETED receives everything; product-tracked lines put stock into a lot
  for (const it of rec.items) {
    const prevReceived = before?.items.find((x) => x.id === it.id)?.received_quantity ?? 0;
    if (rec.status === 'COMPLETED') it.received_quantity = it.quantity;
    if (!RECEIVED.includes(rec.status)) it.received_quantity = 0;
    const delta = it.received_quantity - prevReceived;
    const product = it.product_id ? store.products.get(it.product_id) : undefined;
    if (delta !== 0 && product?.tracking === 'PRODUCT' && it.location_id) {
      let lot = store.lotsForProduct(product.id).find((l) => l.location_id === it.location_id && !l.batch_id);
      if (!lot) {
        lot = { id: store.newId(), product_id: product.id, batch_id: null, location_id: it.location_id, quantity_initial: 0, quantity: 0, compliance_label: null, metrc_id: null, on_hold: false, inserted_datetime: now, updated_datetime: now };
        store.lots.set(lot.id, lot);
      }
      lot.quantity = Math.max(0, lot.quantity + delta);
      lot.quantity_initial += Math.max(0, delta);
      lot.updated_datetime = now;
    }
  }
  store.purchases.set(rec.id, rec);
  return { ok: true, created: !existing, record: rec, before };
}

export function upsertOrder(store: Store, body: unknown): UpsertResult<OrderRec> {
  const errs = new Errors();
  if (!isObj(body)) return { ok: false, status: 400, errors: [{ message: 'Request body must be a JSON object', pointer: ['base'] }] };
  let existing: OrderRec | undefined;
  if (body.id != null) {
    if (typeof body.id !== 'string') return { ok: false, status: 400, errors: [{ message: 'is invalid', pointer: ['id'] }] };
    existing = store.orders.get(body.id);
    if (!existing) return { ok: false, status: 404, errors: [{ message: 'Order not found', pointer: ['base'] }] };
  }
  const before = existing ? structuredClone(existing) : null;
  let status: OrderStatus = existing?.status ?? 'PENDING';
  if (has(body, 'status')) {
    if (typeof body.status !== 'string' || !ORDER_STATUSES.includes(body.status as OrderStatus)) errs.add(['status'], `is invalid; must be one of ${ORDER_STATUSES.join(', ')}`);
    else status = body.status as OrderStatus;
  }
  const company_id = idField(body, 'company_id', errs);
  const location_id = idField(body, 'location_id', errs);
  const billing_location_id = idField(body, 'billing_location_id', errs);
  const shipping_location_id = idField(body, 'shipping_location_id', errs);
  const order_datetime = dtField(body, 'order_datetime', errs);
  const due_datetime = dtField(body, 'due_datetime', errs);
  const delivery_datetime = dtField(body, 'delivery_datetime', errs);
  const internal_notes = strField(body, 'internal_notes', errs);
  const external_notes = strField(body, 'external_notes', errs);
  if (company_id && !store.companies.has(company_id)) errs.add(['company_id'], 'does not exist');
  if (location_id && !store.ownLocationIds.includes(location_id)) errs.add(['location_id'], 'does not exist or is not one of your locations');
  for (const [k, v] of [['billing_location_id', billing_location_id], ['shipping_location_id', shipping_location_id]] as const) {
    if (v && !store.locations.has(v)) errs.add([k], 'does not exist');
  }
  const companyId = company_id ?? existing?.company_id;
  const locationId = location_id ?? existing?.location_id;
  if (!companyId) errs.add(['company_id'], "can't be blank");
  if (!locationId) errs.add(['location_id'], "can't be blank");

  let items: OrderItemRec[] | undefined;
  if (has(body, 'items')) {
    if (!Array.isArray(body.items)) errs.add(['items'], 'must be a list');
    else {
      const list: OrderItemRec[] = (items = []);
      body.items.forEach((raw, i) => {
        const at = (k: string) => ['items', i, k];
        if (!isObj(raw)) return errs.add(['items', i], 'must be an object');
        const prev = raw.id != null ? existing?.items.find((x) => x.id === raw.id) : undefined;
        if (raw.id != null && !prev) return errs.add(at('id'), 'does not exist on this order');
        const item: OrderItemRec = prev
          ? { ...prev }
          : { id: store.newId(), product_id: '', batch_id: null, package_id: null, location_id: locationId ?? '', quantity: NaN, price: NaN, price_base: NaN, is_sample: false, note: null, inserted_datetime: store.nowIso() };
        if (has(raw, 'product_id')) {
          if (typeof raw.product_id !== 'string' || !store.products.has(raw.product_id)) errs.add(at('product_id'), 'does not exist');
          else item.product_id = raw.product_id;
        } else if (!prev) errs.add(at('product_id'), "can't be blank");
        if (has(raw, 'location_id')) {
          if (typeof raw.location_id !== 'string' || !store.ownLocationIds.includes(raw.location_id)) errs.add(at('location_id'), 'does not exist or is not one of your locations');
          else item.location_id = raw.location_id;
        }
        const q = numField(raw, 'quantity', at('quantity'), errs);
        const pb = numField(raw, 'price_base', at('price_base'), errs);
        const price = numField(raw, 'price', at('price'), errs);
        if (q !== undefined) item.quantity = q;
        if (pb !== undefined) item.price_base = pb;
        if (price !== undefined) item.price = price;
        else if (pb !== undefined && !prev) item.price = pb;
        if (!prev && q === undefined) errs.add(at('quantity'), "can't be blank");
        if (!prev && pb === undefined) errs.add(at('price_base'), "can't be blank");
        if (q !== undefined && q <= 0) errs.add(at('quantity'), 'must be greater than 0');
        if (typeof raw.note === 'string') item.note = raw.note;
        if (typeof raw.is_sample === 'boolean') item.is_sample = raw.is_sample;
        list.push(item);
      });
    }
  }
  if (!existing && !items?.length && !errs.list.some((e) => e.pointer[0] === 'items')) errs.add(['items'], 'must contain at least one line item');
  const charges = parseCharges(body.charges, existing?.charges ?? [], store, errs);
  if (errs.list.length) return { ok: false, status: 400, errors: errs.list };

  const now = store.nowIso();
  const customerLoc = store.companies.get(companyId!)?.location_ids[0] ?? null;
  const rec: OrderRec = existing ?? {
    id: store.newId(),
    order_number: `SO-${++store.counters.order}`,
    status,
    company_id: companyId!,
    location_id: locationId!,
    billing_location_id: customerLoc,
    shipping_location_id: customerLoc,
    order_datetime: now,
    due_datetime: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    delivery_datetime: null,
    delivered_datetime: null,
    internal_notes: null,
    external_notes: null,
    items: [],
    charges: [],
    inserted_datetime: now,
    updated_datetime: now,
  };
  rec.status = status;
  if (company_id) rec.company_id = company_id;
  if (location_id) rec.location_id = location_id;
  if (billing_location_id !== undefined) rec.billing_location_id = billing_location_id;
  if (shipping_location_id !== undefined) rec.shipping_location_id = shipping_location_id;
  if (order_datetime) rec.order_datetime = order_datetime;
  if (due_datetime) rec.due_datetime = due_datetime;
  if (delivery_datetime !== undefined) rec.delivery_datetime = delivery_datetime;
  if (internal_notes !== undefined) rec.internal_notes = internal_notes;
  if (external_notes !== undefined) rec.external_notes = external_notes;
  if (items) rec.items = items;
  if (charges) rec.charges = charges;
  if ((status === 'DELIVERED' || status === 'COMPLETED') && !rec.delivered_datetime) rec.delivered_datetime = now;
  rec.updated_datetime = now;
  store.orders.set(rec.id, rec);
  return { ok: true, created: !existing, record: rec, before };
}
