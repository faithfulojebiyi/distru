/**
 * Write rules for the records added after the first cut: custom field values, tasks, purchase delete,
 * stock adjustments, custom field definitions. Pure store mutations with Distru-style validation;
 * side effects (history, webhooks) are applied by ops.ts.
 */
import type { Store } from './store';
import type { CustomFieldDefRec, LotRec, PurchaseRec, StockAdjustmentRec, TaskLinkKind, TaskRec } from './types';
import type { ApiErrorItem } from './upsert';

type Ptr = (string | number)[];
export type WriteResult<T> = { ok: true; created: boolean; record: T; before: T | null } | { ok: false; status: 400 | 404; errors: ApiErrorItem[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
export const ISO_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/** Task colors: REST takes/returns a hex code without `#`, MCP takes/returns the name. */
export const TASK_COLORS: Record<string, string> = {
  RED: 'E53935',
  LIGHT_RED: 'EF9A9A',
  ORANGE: 'FB8C00',
  LIGHT_ORANGE: 'FFCC80',
  GOLD: 'C9A227',
  YELLOW: 'FDD835',
  GREEN: '43A047',
  LIGHT_GREEN: 'A5D6A7',
  BLUE: '1E88E5',
  LIGHT_BLUE: '90CAF9',
  CYAN: '00ACC1',
  LIGHT_CYAN: '80DEEA',
  INDIGO: '3949AB',
  LIGHT_INDIGO: '9FA8DA',
  PURPLE: '8E24AA',
  LIGHT_PURPLE: 'CE93D8',
  GRAY: '757575',
  LIGHT_GRAY: 'E0E0E0',
};
export const DEFAULT_TASK_COLOR = TASK_COLORS.BLUE!;
export const colorName = (hex: string | null): string | null => (hex ? (Object.entries(TASK_COLORS).find(([, h]) => h === hex.toUpperCase())?.[0] ?? null) : null);

/**
 * Validates `custom_data` (map of field id → value; null clears) against the definitions for one
 * parent object and returns the merged map, or undefined when nothing was sent.
 */
export function applyCustomData(store: Store, parentObject: string, raw: unknown, current: Record<string, unknown>, errs: ApiErrorItem[], ptr: Ptr = ['custom_data']): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return {};
  if (!isObj(raw)) {
    errs.push({ message: 'must be an object of custom field id → value', pointer: ptr });
    return undefined;
  }
  const out = { ...current };
  for (const [key, value] of Object.entries(raw)) {
    const def = store.customFields.get(Number(key));
    const at = [...ptr, key];
    if (!def || def.parent_object !== parentObject) {
      errs.push({ message: `is not a ${parentObject} custom field`, pointer: at });
      continue;
    }
    if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
      delete out[key];
      continue;
    }
    const msg = customValueError(def, value);
    if (msg) errs.push({ message: msg, pointer: at });
    else out[key] = def.field_type === 'date' ? new Date(String(value)).toISOString() : value;
  }
  return out;
}

function customValueError(def: CustomFieldDefRec, value: unknown): string | null {
  switch (def.field_type) {
    case 'text':
      return typeof value === 'string' ? null : 'must be a string';
    case 'date':
      return typeof value === 'string' && ISO_DT.test(value) && !Number.isNaN(Date.parse(value)) ? null : 'must be a full ISO8601 datetime';
    case 'dropdown':
      return typeof value === 'string' && def.field_options.includes(value) ? null : `must be one of ${def.field_options.join(', ')}`;
    case 'checkbox':
      return Array.isArray(value) && value.every((v) => typeof v === 'string' && def.field_options.includes(v)) ? null : `must be a list of options from ${def.field_options.join(', ')}`;
  }
}

/** Custom field values as REST shows them on a record: every definition of the parent object. */
export function customDataList(store: Store, parentObject: string, values: Record<string, unknown>) {
  return [...store.customFields.values()]
    .filter((d) => d.parent_object === parentObject)
    .map((d) => {
      const v = values[String(d.id)];
      return { id: d.id, name: d.name, value: v === undefined || v === null ? null : Array.isArray(v) ? v.join(', ') : String(v) };
    });
}

// ── tasks ────────────────────────────────────────────────────────────────────────────────────────

const LINK_FIELDS: [string, TaskLinkKind][] = [
  ['order_id', 'order'],
  ['invoice_id', 'invoice'],
  ['purchase_id', 'purchase'],
  ['contact_id', 'contact'],
  ['product_id', 'product'],
  ['batch_id', 'batch'],
  ['assembly_id', 'assembly'],
  ['return_id', 'return'],
  ['company_id', 'company'],
];

function linkExists(store: Store, kind: TaskLinkKind, id: string): boolean {
  switch (kind) {
    case 'order':
      return store.orders.has(id);
    case 'purchase':
      return store.purchases.has(id);
    case 'product':
      return store.products.has(id);
    case 'batch':
      return store.batches.has(id);
    case 'company':
      return store.companies.has(id);
    default:
      return false; // the mock has no invoices, contacts, assemblies or returns
  }
}

/** POST /public/v1/tasks semantics (also used by distru-mutate-task). */
export function upsertTask(store: Store, body: unknown, creatorId: string | null): WriteResult<TaskRec> {
  if (!isObj(body)) return { ok: false, status: 400, errors: [{ message: 'Request body must be a JSON object', pointer: ['base'] }] };
  const errs: ApiErrorItem[] = [];
  let existing: TaskRec | undefined;
  if (body.id != null) {
    if (typeof body.id !== 'string') return { ok: false, status: 400, errors: [{ message: 'is invalid', pointer: ['id'] }] };
    existing = store.tasks.get(body.id);
    if (!existing) return { ok: false, status: 404, errors: [{ message: 'Task not found', pointer: ['base'] }] };
  }
  const before = existing ? structuredClone(existing) : null;
  const next: TaskRec = existing
    ? structuredClone(existing)
    : {
        id: store.newId(),
        name: '',
        description: null,
        status: 'ACTIVE',
        due_datetime: '',
        color: DEFAULT_TASK_COLOR,
        owner_id: null,
        creator_id: creatorId,
        location_id: null,
        link: null,
        custom_data: {},
        inserted_datetime: store.nowIso(),
        updated_datetime: store.nowIso(),
      };

  if (has(body, 'name')) {
    if (typeof body.name !== 'string' || !body.name.trim()) errs.push({ message: "can't be blank", pointer: ['name'] });
    else next.name = body.name.trim();
  } else if (!existing) errs.push({ message: "can't be blank", pointer: ['name'] });
  if (has(body, 'status')) {
    if (body.status !== 'ACTIVE' && body.status !== 'COMPLETED') errs.push({ message: 'is invalid; must be one of ACTIVE, COMPLETED', pointer: ['status'] });
    else next.status = body.status;
  } else if (!existing) errs.push({ message: "can't be blank", pointer: ['status'] });
  if (has(body, 'due_datetime')) {
    const v = body.due_datetime;
    if (typeof v !== 'string' || !ISO_DT.test(v) || Number.isNaN(Date.parse(v))) errs.push({ message: v === null ? "can't be blank" : 'must be a full ISO8601 datetime', pointer: ['due_datetime'] });
    else next.due_datetime = new Date(v).toISOString();
  } else if (!existing) errs.push({ message: "can't be blank", pointer: ['due_datetime'] });
  if (has(body, 'description')) {
    if (body.description !== null && typeof body.description !== 'string') errs.push({ message: 'must be a string', pointer: ['description'] });
    else next.description = body.description;
  }
  if (has(body, 'color')) {
    if (body.color === null) next.color = DEFAULT_TASK_COLOR;
    else if (typeof body.color !== 'string' || !/^[0-9A-Fa-f]{6}$/.test(body.color)) errs.push({ message: 'must be a 6-digit hex color without #', pointer: ['color'] });
    else next.color = body.color.toUpperCase();
  }
  if (has(body, 'owner_id')) {
    if (body.owner_id === null) next.owner_id = null;
    else if (typeof body.owner_id !== 'string' || !store.users.has(body.owner_id)) errs.push({ message: 'does not exist', pointer: ['owner_id'] });
    else next.owner_id = body.owner_id;
  }
  if (has(body, 'location_id')) {
    const loc = typeof body.location_id === 'string' ? store.locations.get(body.location_id) : undefined;
    if (body.location_id === null) next.location_id = null;
    else if (!loc) errs.push({ message: 'does not exist', pointer: ['location_id'] });
    else if (!loc.company_id) errs.push({ message: "must be one of a company's locations, not your own", pointer: ['location_id'] });
    else next.location_id = loc.id;
  }
  const links = LINK_FIELDS.filter(([k]) => has(body, k) && body[k] != null);
  if (links.length > 1) errs.push({ message: `set at most one of ${LINK_FIELDS.map(([k]) => k).join(', ')}`, pointer: ['base'] });
  else if (links.length === 1) {
    const [field, kind] = links[0]!;
    const id = body[field];
    if (typeof id !== 'string' || !linkExists(store, kind, id)) errs.push({ message: 'does not exist', pointer: [field] });
    else if (existing?.link && (existing.link.kind !== kind || existing.link.id !== id)) errs.push({ message: 'the linked record is set once and cannot be changed', pointer: [field] });
    else next.link = { kind, id };
  }
  const custom = applyCustomData(store, 'task', body.custom_data, next.custom_data, errs);
  if (custom) next.custom_data = custom;
  if (errs.length) return { ok: false, status: 400, errors: errs };
  next.updated_datetime = store.nowIso();
  store.tasks.set(next.id, next);
  return { ok: true, created: !existing, record: next, before };
}

export function deleteTask(store: Store, id: string): WriteResult<TaskRec> {
  const t = store.tasks.get(id);
  if (!t) return { ok: false, status: 404, errors: [{ message: 'Task not found', pointer: ['base'] }] };
  store.tasks.delete(id);
  store.deletedRecords.push({ record_type: 'TASK', record_id: id, deleted_datetime: store.nowIso() });
  return { ok: true, created: false, record: t, before: t };
}

// ── purchase delete (MCP distru-mutate-purchase-order DELETE) ────────────────────────────────────

export function deletePurchase(store: Store, id: string): WriteResult<PurchaseRec> {
  const p = store.purchases.get(id);
  if (!p) return { ok: false, status: 404, errors: [{ message: 'Purchase not found', pointer: ['base'] }] };
  if (p.metrc_transfer_id) return { ok: false, status: 400, errors: [{ message: 'purchases synced to Metrc (matched to a compliance transfer) cannot be deleted', pointer: ['base'] }] };
  // stock it received is taken back out first; refused when that stock is no longer there
  const takeBack: [LotRec, number][] = [];
  for (const it of p.items) {
    if (it.received_quantity <= 0) continue;
    const lot = it.product_id ? store.lotsForProduct(it.product_id).find((l) => l.location_id === it.location_id && !l.batch_id) : undefined;
    if (!lot || lot.quantity < it.received_quantity) {
      return { ok: false, status: 400, errors: [{ message: 'the stock this purchase received was already sold, transferred, adjusted or assembled', pointer: ['base'] }] };
    }
    takeBack.push([lot, it.received_quantity]);
  }
  const now = store.nowIso();
  for (const [lot, q] of takeBack) {
    lot.quantity -= q;
    lot.updated_datetime = now;
  }
  store.purchases.delete(id);
  for (const [tid, t] of store.tasks) {
    if (t.link?.kind === 'purchase' && t.link.id === id) {
      store.tasks.delete(tid);
      store.deletedRecords.push({ record_type: 'TASK', record_id: tid, deleted_datetime: now });
    }
  }
  store.deletedRecords.push({ record_type: 'PURCHASE', record_id: id, deleted_datetime: now });
  return { ok: true, created: false, record: p, before: p };
}

// ── stock adjustments (MCP distru-adjust-inventory) ──────────────────────────────────────────────

export const ADJUSTMENT_REASONS = ['DAMAGED', 'EXPIRED', 'FIRE', 'LAB_TESTING', 'OTHER', 'REVALUATION', 'STOLEN', 'WASTE', 'WRITE_OFF'] as const;
/** Metrc adjustment reasons the mock accepts for packages (California set, abridged). */
export const METRC_ADJUSTMENT_REASONS = ['Damage', 'Drying', 'Entry Error', 'Mandatory State Destruction', 'Scale Variance', 'Spoilage', 'Theft', 'Waste'];

export interface AdjustInput {
  packageId?: string;
  batchId?: string;
  productId?: string;
  locationId?: string;
  quantity: number;
  reason?: string;
  complianceReason?: string;
  description?: string;
  adjustedDatetime?: string;
}

export type AdjustResult = { ok: true; adjustment: StockAdjustmentRec; lots: LotRec[] } | { ok: false; errors: { message: string; path: string[] }[] };

/**
 * Applies a signed quantity change to one package, batch or product-tracked product. A Metrc package
 * gets a compliance activity (QUEUED → SUCCESS, or FAILED when the mock is told Metrc rejects it —
 * the Distru change stays either way).
 */
export function adjustInventory(store: Store, input: AdjustInput, opts: { metrcFails: boolean; source: StockAdjustmentRec['source'] }): AdjustResult {
  const errors: { message: string; path: string[] }[] = [];
  const err = (path: string, message: string) => errors.push({ message, path: [path] });
  const targets = [input.packageId, input.batchId, input.productId].filter(Boolean);
  if (targets.length !== 1) return { ok: false, errors: [{ message: 'set exactly one of packageId, batchId or productId', path: [] }] };
  if (!Number.isFinite(input.quantity) || input.quantity === 0) err('quantity', 'must be a non-zero number');
  const now = store.nowIso();
  let lots: LotRec[] = [];
  let productId = '';
  let packageLot: LotRec | undefined;
  if (input.packageId) {
    packageLot = store.lots.get(input.packageId);
    if (!packageLot || !packageLot.compliance_label) return { ok: false, errors: [{ message: 'package not found', path: ['packageId'] }] };
    if (!input.description) err('description', 'is required for a package');
    else if (input.description.length > 250) err('description', 'at most 250 characters for a package');
    if (!input.complianceReason) err('complianceReason', 'is required for a package');
    else if (!METRC_ADJUSTMENT_REASONS.includes(input.complianceReason)) err('complianceReason', `is not a Metrc adjustment reason; valid: ${METRC_ADJUSTMENT_REASONS.join(', ')}`);
    lots = [packageLot];
    productId = packageLot.product_id;
  } else {
    if (!input.reason) err('reason', 'is required for a batch or product');
    else if (!(ADJUSTMENT_REASONS as readonly string[]).includes(input.reason)) err('reason', `must be one of ${ADJUSTMENT_REASONS.join(', ')}`);
    if (input.reason === 'WASTE' && input.quantity > 0) err('quantity', 'WASTE takes a negative quantity');
    if (input.description && input.description.length > 800) err('description', 'at most 800 characters');
    if (input.batchId) {
      const b = store.batches.get(input.batchId);
      if (!b) return { ok: false, errors: [{ message: 'batch not found', path: ['batchId'] }] };
      if (store.products.get(b.product_id)?.tracking !== 'BATCH') return { ok: false, errors: [{ message: 'is not a batch of a batch-tracked product', path: ['batchId'] }] };
      productId = b.product_id;
      lots = [...store.lots.values()].filter((l) => l.batch_id === b.id);
    } else {
      const p = store.products.get(input.productId!);
      if (!p) return { ok: false, errors: [{ message: 'product not found', path: ['productId'] }] };
      if (p.tracking !== 'PRODUCT') return { ok: false, errors: [{ message: `is ${p.tracking.toLowerCase()}-tracked: adjust its ${p.tracking === 'PACKAGE' ? 'packages (packageId)' : 'batches (batchId)'}`, path: ['productId'] }] };
      productId = p.id;
      lots = store.lotsForProduct(p.id).filter((l) => !l.batch_id);
    }
    const locs = [...new Set(lots.filter((l) => l.quantity > 0).map((l) => l.location_id))];
    if (input.locationId) {
      if (!store.ownLocationIds.includes(input.locationId)) err('locationId', 'is not one of your locations');
      lots = lots.filter((l) => l.location_id === input.locationId);
    } else if (locs.length > 1) err('locationId', 'is required: the stock sits in more than one location');
    else lots = lots.filter((l) => l.location_id === (locs[0] ?? input.locationId));
  }
  if (input.adjustedDatetime !== undefined && (!ISO_DT.test(input.adjustedDatetime) || Number.isNaN(Date.parse(input.adjustedDatetime)))) {
    err('adjustedDatetime', 'must be an ISO 8601 timestamp with a UTC offset');
  }
  if (errors.length) return { ok: false, errors };

  // product-tracked stock at a location without a row yet: create one for a positive change
  if (!lots.length && input.productId && input.quantity > 0) {
    const loc = input.locationId ?? store.ownLocationIds[0]!;
    const lot: LotRec = { id: store.newId(), product_id: productId, batch_id: null, location_id: loc, quantity_initial: 0, quantity: 0, compliance_label: null, metrc_id: null, on_hold: false, inserted_datetime: now, updated_datetime: now };
    store.lots.set(lot.id, lot);
    lots = [lot];
  }
  const total = lots.reduce((s, l) => s + l.quantity, 0);
  if (total + input.quantity < 0) return { ok: false, errors: [{ message: `would take quantity below 0 (current ${total})`, path: ['quantity'] }] };
  // spread a loss over the lots (largest first); a gain lands on the first lot
  let remaining = input.quantity;
  const touched: LotRec[] = [];
  for (const lot of [...lots].sort((a, b) => b.quantity - a.quantity)) {
    if (remaining === 0) break;
    const delta = remaining > 0 ? remaining : Math.max(remaining, -lot.quantity);
    lot.quantity += delta;
    if (delta > 0) lot.quantity_initial += delta;
    lot.updated_datetime = now;
    remaining -= delta;
    touched.push(lot);
  }
  const adj: StockAdjustmentRec = {
    id: store.newId(),
    quantity: input.quantity,
    reason: input.reason ?? null,
    description: input.description ?? null,
    adjusted_datetime: input.adjustedDatetime ? new Date(input.adjustedDatetime).toISOString() : now,
    location_id: touched[0]?.location_id ?? input.locationId ?? null,
    package_id: packageLot?.id ?? null,
    batch_id: input.batchId ?? packageLot?.batch_id ?? null,
    product_id: productId,
    compliance_activity: packageLot?.metrc_id
      ? {
          id: String(++store.counters.metrcActivity),
          system: 'METRC',
          status: opts.metrcFails ? 'FAILED' : 'SUCCESS',
          error: opts.metrcFails ? 'Metrc rejected the adjustment: Package quantity in Metrc does not match (mock failure)' : null,
        }
      : null,
    source: opts.source,
    inserted_datetime: now,
  };
  store.adjustments.set(adj.id, adj);
  return { ok: true, adjustment: adj, lots: touched };
}

// ── custom field definitions (POST /public/v1/custom-fields) ─────────────────────────────────────

const PARENT_OBJECTS = ['purchase', 'order', 'product', 'company', 'batch', 'package', 'task', 'invoice', 'contact', 'assembly'];

export function createCustomField(store: Store, body: unknown): WriteResult<CustomFieldDefRec> {
  if (!isObj(body)) return { ok: false, status: 400, errors: [{ message: 'Request body must be a JSON object', pointer: ['base'] }] };
  const errs: ApiErrorItem[] = [];
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) errs.push({ message: "can't be blank", pointer: ['name'] });
  const parent = body.parent_object;
  if (typeof parent !== 'string' || !PARENT_OBJECTS.includes(parent)) errs.push({ message: `must be one of ${PARENT_OBJECTS.join(', ')}`, pointer: ['parent_object'] });
  const type = body.field_type;
  if (type !== 'checkbox' && type !== 'date' && type !== 'dropdown' && type !== 'text') errs.push({ message: 'must be one of checkbox, date, dropdown, text', pointer: ['field_type'] });
  const options = Array.isArray(body.field_options) ? body.field_options.filter((o): o is string => typeof o === 'string') : [];
  if ((type === 'dropdown' || type === 'checkbox') && !options.length) errs.push({ message: 'needs at least one option for a dropdown or checkbox field', pointer: ['field_options'] });
  const filterable = body.filterable === true;
  if (filterable && type !== 'dropdown' && type !== 'checkbox') errs.push({ message: 'only dropdown and checkbox fields can be filterable', pointer: ['filterable'] });
  if (name && typeof parent === 'string' && [...store.customFields.values()].some((d) => d.parent_object === parent && d.name.toLowerCase() === name.toLowerCase())) {
    errs.push({ message: 'has already been taken', pointer: ['name'] });
  }
  if (errs.length) return { ok: false, status: 400, errors: errs };
  const rec: CustomFieldDefRec = {
    id: ++store.counters.customField,
    name,
    description: typeof body.description === 'string' ? body.description : null,
    parent_object: parent as string,
    field_type: type as CustomFieldDefRec['field_type'],
    filterable,
    required: body.required === true,
    field_options: options,
    disabled_field_options: [],
    inserted_datetime: store.nowIso(),
  };
  store.customFields.set(rec.id, rec);
  return { ok: true, created: true, record: rec, before: null };
}
