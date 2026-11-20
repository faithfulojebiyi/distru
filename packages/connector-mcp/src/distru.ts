/**
 * Distru MCP preset (https://mcp.distru.com/mcp, Streamable HTTP; key `distru_mcp_…`).
 *
 * Conventions this preset relies on (docs/research/FINDINGS.md, mcp_conventions.md):
 * - Every tool takes `intent` + `userSatisfactionEstimate` (and `account` with linked accounts):
 *   filled from run context, never asked of the agent.
 * - Writes are `distru-mutate-<record>` with `action: CREATE|UPDATE|DELETE`, sparse; lists replace.
 * - `x-distru-filter-tool-tags: read` hides write tools (read-only use).
 * - No dry-run, idempotency or undo on any write → everything here goes through propose/approve,
 *   and DELETE is split out as its own high-risk action.
 */
import { InputValidationError, matchesExpected, type CompensableOp, type OpResult, type VerifyResult, type WrittenRecord } from '@ops/harness';
import { z } from 'zod';
import { createMcpConnector, hasMarker, runContextOf, stampText, stripMarkers, type IntentArgs, type McpBridge, type McpConnectorConfig, type McpHookContext, type McpToolHooks, type McpUndoPlan } from './connector';
import { DISTRU_TOOL_TABLE } from './distru-tools';
import type { JsonObject } from './schema';

export const DISTRU_MCP_DEFAULT_URL = 'https://mcp.distru.com/mcp';
export const DISTRU_READ_ONLY_HEADER = { 'x-distru-filter-tool-tags': 'read' } as const;
export const DISTRU_INJECTED_FIELDS = ['intent', 'userSatisfactionEstimate', 'account'] as const;

const PO_STATUSES = ['DRAFT', 'PENDING', 'PROCESSING', 'DELIVERING', 'PARTIALLY_RECEIVED', 'COMPLETED'];
const TASK_STATUSES = ['ACTIVE', 'COMPLETED'];
/** How many recent records a CREATE dedupe scans for the stamped marker. */
const CREATE_SCAN_LIMIT = 10;

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * Distru accepts ids with or without their type prefix (`com_1` or `1`) but returns them prefixed,
 * so read-back comparisons drop the prefix on id-valued keys (`id`, `…Id`) on both sides.
 */
export const unprefixId = (v: string): string => v.replace(/^[a-z]{2,6}_(?=.)/, '');
export function unprefixIds<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => unprefixIds(v)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeof v === 'string' && (k === 'id' || k.endsWith('Id')) ? unprefixId(v) : unprefixIds(v)])) as T;
  }
  return value;
}
const sameId = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' ? unprefixId(a) === unprefixId(b) : a === b;

// ── Purchase orders ─────────────────────────────────────────────────────────────────────────

const Ref = z.object({ id: z.string() }).passthrough().nullish();
const PoItem = z.object({ id: z.string(), quantity: z.unknown().optional(), price: z.unknown().optional(), product: Ref, batch: Ref }).passthrough();
const PoCharge = z.object({ id: z.string(), name: z.string().nullish(), type: z.string().nullish(), unitType: z.string().nullish(), percent: z.unknown().optional(), price: z.unknown().optional() }).passthrough();
const PurchaseOrderSchema = z
  .object({
    id: z.string(),
    purchaseNumber: z.string().nullish(),
    status: z.string().nullish(),
    description: z.string().nullish(),
    supplier: Ref,
    intakeLocation: Ref,
    billingLocation: Ref,
    supplierLocation: Ref,
    owner: Ref,
    customFields: z.array(z.object({ customField: z.object({ id: z.string() }).passthrough(), value: z.string().nullish() }).passthrough()).nullish(),
    orderItems: z.array(PoItem).nullish(),
    orderCharges: z.array(PoCharge).nullish(),
    total: z.unknown().optional(),
  })
  .passthrough();
type PurchaseOrder = z.infer<typeof PurchaseOrderSchema>;

/** A Distru PO normalized to `distru-mutate-purchase-order` argument names, so diff/verify are field-to-field. */
export interface NormalizedPurchaseOrder {
  id: string;
  purchaseNumber: string | null;
  status: string | null;
  supplierId: string | null;
  intakeLocationId: string | null;
  billingLocationId: string | null;
  supplierLocationId: string | null;
  ownerId: string | null;
  description: string | null;
  orderItems: Array<{ id: string; productId: string | null; batchId: string | null; quantity: number | null; price: number | null }>;
  orderCharges: Array<{ id: string; name: string | null; type: string | null; unitType: string | null; percent: number | null; price: number | null }>;
  customFields: Array<{ customFieldId: string; value: string | null }>;
  total: number | null;
}

export function normalizePurchaseOrder(po: PurchaseOrder): NormalizedPurchaseOrder {
  return {
    id: po.id,
    purchaseNumber: po.purchaseNumber ?? null,
    status: po.status ?? null,
    supplierId: po.supplier?.id ?? null,
    intakeLocationId: po.intakeLocation?.id ?? null,
    billingLocationId: po.billingLocation?.id ?? null,
    supplierLocationId: po.supplierLocation?.id ?? null,
    ownerId: po.owner?.id ?? null,
    description: stripMarkers(po.description),
    orderItems: (po.orderItems ?? []).map((i) => ({ id: i.id, productId: i.product?.id ?? null, batchId: i.batch?.id ?? null, quantity: num(i.quantity), price: num(i.price) })),
    orderCharges: (po.orderCharges ?? []).map((c) => ({ id: c.id, name: c.name ?? null, type: c.type ?? null, unitType: c.unitType ?? null, percent: num(c.percent), price: num(c.price) })),
    customFields: (po.customFields ?? []).map((f) => ({ customFieldId: f.customField.id, value: f.value ?? null })),
    total: num(po.total),
  };
}

const poOf = (result: unknown): PurchaseOrder | null => {
  const parsed = z.object({ purchaseOrder: PurchaseOrderSchema.nullish() }).passthrough().safeParse(result);
  return parsed.success ? (parsed.data.purchaseOrder ?? null) : null;
};

async function getPo(h: McpHookContext, id: string): Promise<PurchaseOrder | null> {
  return poOf(await h.read('distru-get-purchase-order', { id, includeOrderItems: true, includeOrderCharges: true }));
}

const SearchItems = z.object({ items: z.array(z.object({ id: z.string() }).passthrough()) }).passthrough();
const searchIds = (result: unknown): string[] => {
  const parsed = SearchItems.safeParse(result);
  return parsed.success ? parsed.data.items.map((i) => i.id) : [];
};

/** The fields of a `mutate-purchase-order` payload a read-back must reproduce. */
export function expectedPurchaseOrder(payload: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const k of ['status', 'supplierId', 'intakeLocationId', 'billingLocationId', 'supplierLocationId', 'ownerId'] as const) {
    if (payload[k] !== undefined && payload[k] !== null) out[k] = payload[k];
  }
  if (typeof payload.description === 'string') out.description = stripMarkers(payload.description);
  if (Array.isArray(payload.orderItems)) {
    out.orderItems = payload.orderItems.filter((i): i is JsonObject => typeof i === 'object' && i !== null).map((i) => {
      const line: JsonObject = {};
      for (const k of ['id', 'productId', 'batchId', 'quantity', 'price'] as const) if (i[k] !== undefined && i[k] !== null) line[k] = i[k];
      return line;
    });
  }
  return out;
}

export interface DistruPresetOptions {
  /**
   * Id of a TEXT custom field on purchase orders used for the idempotency key (FINDINGS rec. 5:
   * searchable via `customFields[].contains`). Without it the key is stamped into the description
   * and found by scanning recent POs.
   */
  idempotencyCustomFieldId?: string;
}

export function purchaseOrderHooks(options: DistruPresetOptions = {}): McpToolHooks {
  const fieldId = options.idempotencyCustomFieldId;
  return {
    before: async (h, payload) => {
      if (payload.action !== 'UPDATE' && payload.action !== 'DELETE') return null;
      const id = str(payload.id);
      if (!id) throw new InputValidationError(`id is required for ${String(payload.action)}`);
      const po = await getPo(h, id);
      if (!po) throw new InputValidationError(`Purchase order ${id} not found`);
      return normalizePurchaseOrder(po);
    },

    stamp: async (payload, key, h) => {
      if (fieldId) {
        const existing = Array.isArray(payload.customFields) ? payload.customFields.filter((f) => !(typeof f === 'object' && f !== null && 'customFieldId' in f && f.customFieldId === fieldId)) : [];
        return { ...payload, customFields: [...existing, { customFieldId: fieldId, value: key }] };
      }
      // Sparse UPDATE without description: stamp the current notes, never clobber them.
      let base = payload.description;
      if (payload.action === 'UPDATE' && base === undefined && str(payload.id)) base = (await getPo(h, String(payload.id)))?.description ?? null;
      return { ...payload, description: stampText(base, key) };
    },

    find: async (h, key): Promise<WrittenRecord<unknown> | null> => {
      // DELETE is not stamped; the executor record covers it, and verify confirms the PO is gone.
      if (fieldId) {
        const ids = searchIds(await h.read('distru-search-purchase-orders', { customFields: [{ customFieldId: fieldId, contains: key }], status: PO_STATUSES, limit: 5 }));
        if (!ids[0]) return null;
        const po = await getPo(h, ids[0]);
        return po ? { recordId: po.id, record: normalizePurchaseOrder(po) } : null;
      }
      const recent = searchIds(await h.read('distru-search-purchase-orders', { status: PO_STATUSES, sortBy: { field: 'UPDATED_AT', direction: 'DESC' }, limit: CREATE_SCAN_LIMIT }));
      for (const id of recent) {
        const po = await getPo(h, id);
        if (po && hasMarker(po.description, key)) return { recordId: po.id, record: normalizePurchaseOrder(po) };
      }
      return null;
    },

    verify: async (h, recordId, payload): Promise<VerifyResult> => {
      const po = await getPo(h, recordId);
      if (payload.action === 'DELETE') {
        return po ? { ok: false, mismatches: [{ path: [], expected: null, actual: { id: po.id, status: po.status } }] } : { ok: true, mismatches: [] };
      }
      if (!po) return { ok: false, mismatches: [{ path: [], expected: expectedPurchaseOrder(payload), actual: null }] };
      return matchesExpected(unprefixIds(normalizePurchaseOrder(po)), unprefixIds(expectedPurchaseOrder(payload)));
    },

    recordIdOf: (parsed, payload) => poOf(parsed)?.id ?? (z.object({ id: z.string() }).safeParse(parsed).data?.id) ?? str(payload.id) ?? undefined,

    value: (payload) => {
      if (!Array.isArray(payload.orderItems)) return 0;
      let total = 0;
      for (const i of payload.orderItems) {
        if (typeof i !== 'object' || i === null) continue;
        const q = num('quantity' in i ? i.quantity : null);
        const p = num('price' in i ? i.price : null);
        if (q !== null && p !== null) total += q * p;
      }
      return Math.round(total * 100) / 100;
    },

    vendorIdsOf: (payload) => (str(payload.supplierId) ? [String(payload.supplierId)] : []),

    summarize: (payload, before) => {
      const b = before && typeof before === 'object' && 'purchaseNumber' in before ? (before as NormalizedPurchaseOrder) : null;
      const label = b?.purchaseNumber ?? (str(payload.id) ? String(payload.id) : 'new purchase order');
      const lines = Array.isArray(payload.orderItems) ? `, ${payload.orderItems.length} line${payload.orderItems.length === 1 ? '' : 's'}` : '';
      if (payload.action === 'DELETE') return `DELETE purchase order ${label} (cascades to payments and QuickBooks bill)`;
      return `${String(payload.action ?? 'CREATE')} purchase order ${label}${lines}${payload.status ? ` → ${String(payload.status)}` : ''}`;
    },
  };
}

// ── Tasks ───────────────────────────────────────────────────────────────────────────────────

const TaskSchema = z
  .object({ id: z.string(), name: z.string().nullish(), description: z.string().nullish(), status: z.string().nullish(), dueDate: z.string().nullish(), owner: Ref, purchaseOrder: Ref })
  .passthrough();
type Task = z.infer<typeof TaskSchema>;

export interface NormalizedTask {
  id: string;
  name: string | null;
  description: string | null;
  status: string | null;
  dueDate: string | null;
  ownerId: string | null;
  purchaseOrderId: string | null;
}

export const normalizeTask = (t: Task): NormalizedTask => ({
  id: t.id,
  name: t.name ?? null,
  description: stripMarkers(t.description),
  status: t.status ?? null,
  dueDate: t.dueDate ?? null,
  ownerId: t.owner?.id ?? null,
  purchaseOrderId: t.purchaseOrder?.id ?? null,
});

async function searchTasks(h: McpHookContext, args: JsonObject): Promise<Task[]> {
  const parsed = z.object({ items: z.array(TaskSchema) }).passthrough().safeParse(await h.read('distru-search-tasks', { statuses: TASK_STATUSES, ...args }));
  return parsed.success ? parsed.data.items : [];
}
const getTask = async (h: McpHookContext, id: string): Promise<Task | null> => (await searchTasks(h, { ids: [id], limit: 1 }))[0] ?? null;

const sameInstant = (a: unknown, b: unknown) => {
  const x = typeof a === 'string' ? Date.parse(a) : NaN;
  const y = typeof b === 'string' ? Date.parse(b) : NaN;
  return Number.isFinite(x) && x === y;
};

export function taskHooks(): McpToolHooks {
  return {
    moneyless: true,
    before: async (h, payload) => {
      if (payload.action !== 'UPDATE' && payload.action !== 'DELETE') return null;
      const id = str(payload.id);
      if (!id) throw new InputValidationError(`id is required for ${String(payload.action)}`);
      const task = await getTask(h, id);
      if (!task) throw new InputValidationError(`Task ${id} not found`);
      return normalizeTask(task);
    },
    stamp: async (payload, key, h) => {
      let base = payload.description;
      if (payload.action === 'UPDATE' && base === undefined && str(payload.id)) base = (await getTask(h, String(payload.id)))?.description ?? null;
      return { ...payload, description: stampText(base, key) };
    },
    find: async (h, key) => {
      const recent = await searchTasks(h, { limit: 50 });
      const hit = recent.find((t) => hasMarker(t.description, key));
      return hit ? { recordId: hit.id, record: normalizeTask(hit) } : null;
    },
    verify: async (h, recordId, payload) => {
      const task = await getTask(h, recordId);
      if (payload.action === 'DELETE') return task ? { ok: false, mismatches: [{ path: [], expected: null, actual: { id: task.id } }] } : { ok: true, mismatches: [] };
      if (!task) return { ok: false, mismatches: [{ path: [], expected: { name: payload.name }, actual: null }] };
      const t = normalizeTask(task);
      const mismatches: VerifyResult['mismatches'] = [];
      if (typeof payload.name === 'string' && payload.name !== t.name) mismatches.push({ path: ['name'], expected: payload.name, actual: t.name });
      if (typeof payload.status === 'string' && payload.status !== t.status) mismatches.push({ path: ['status'], expected: payload.status, actual: t.status });
      if (payload.description !== undefined && stripMarkers(payload.description) !== t.description) mismatches.push({ path: ['description'], expected: stripMarkers(payload.description), actual: t.description });
      if (payload.ownerId !== undefined && !sameId(payload.ownerId, t.ownerId)) mismatches.push({ path: ['ownerId'], expected: payload.ownerId, actual: t.ownerId });
      if (typeof payload.dueDate === 'string' && !sameInstant(payload.dueDate, t.dueDate)) mismatches.push({ path: ['dueDate'], expected: payload.dueDate, actual: t.dueDate });
      return { ok: mismatches.length === 0, mismatches };
    },
    recordIdOf: (parsed, payload) => z.object({ task: z.object({ id: z.string() }) }).safeParse(parsed).data?.task.id ?? str(payload.id) ?? undefined,
    summarize: (payload, before) => {
      const name = str(payload.name) ?? (before && typeof before === 'object' && 'name' in before ? String(before.name) : str(payload.id) ?? 'task');
      return `${String(payload.action ?? 'CREATE')} task "${name}"${payload.dueDate ? ` due ${String(payload.dueDate)}` : ''}`;
    },
  };
}

// ── Products ────────────────────────────────────────────────────────────────────────────────

/**
 * Product fields a sparse `distru-mutate-product` UPDATE may change that the read-back can check.
 * `maxMenuBuyerOrderQuantity` is the per-buyer cap on one Distru Commerce menu order (sales reps exempt):
 * the allocation guard sets it while a SKU would stock out before its purchase order arrives.
 */
const PRODUCT_FIELDS = ['name', 'sku', 'externalName', 'maxMenuBuyerOrderQuantity', 'isInactive', 'isFeatured', 'unitsPerCase', 'unitPrice', 'quantityAvailableThresholdMin', 'quantityAvailableThresholdMax'] as const;
const NUMERIC_PRODUCT_FIELDS = new Set<string>(['unitsPerCase', 'unitPrice', 'quantityAvailableThresholdMin', 'quantityAvailableThresholdMax']);

const ProductSchema = z.object({ id: z.string() }).passthrough();
type Product = z.infer<typeof ProductSchema>;

/** A Distru product normalized to `distru-mutate-product` argument names (decimals as numbers). */
export type NormalizedProduct = { id: string } & Partial<Record<(typeof PRODUCT_FIELDS)[number], string | number | boolean | null>>;

export function normalizeProduct(p: Product, id: string = p.id): NormalizedProduct {
  const out: NormalizedProduct = { id };
  for (const k of PRODUCT_FIELDS) {
    const v = p[k];
    if (v === undefined) continue;
    out[k] = NUMERIC_PRODUCT_FIELDS.has(k) ? num(v) : typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null;
  }
  return out;
}

async function getProduct(h: McpHookContext, id: string): Promise<Product | null> {
  const parsed = z.object({ product: ProductSchema.nullish() }).passthrough().safeParse(await h.read('distru-get-product', { id }));
  return parsed.success ? (parsed.data.product ?? null) : null;
}

const sameValue = (k: string, a: unknown, b: unknown) => (NUMERIC_PRODUCT_FIELDS.has(k) ? num(a) === num(b) : a === b);

/**
 * `distru-mutate-product` (UPDATE): `before` = the product via `distru-get-product` (so the diff shows
 * old → new, e.g. `maxMenuBuyerOrderQuantity: null → 24`, and an undo can restore it); `verify` reads
 * it back and compares every field the payload sets. No `find`: a product has no field to stamp a key
 * into without touching customer-facing text, and a sparse UPDATE that sets values is idempotent by
 * value (applying it twice leaves the same product), so the executor record is enough.
 */
export function productHooks(): McpToolHooks {
  return {
    // A catalog setting (cap, price list, flags) moves no money by itself: 0 toward value rules.
    moneyless: true,
    before: async (h, payload) => {
      if (payload.action !== 'UPDATE' && payload.action !== 'DELETE') return null;
      const id = str(payload.id);
      if (!id) throw new InputValidationError(`id is required for ${String(payload.action)}`);
      const product = await getProduct(h, id);
      if (!product) throw new InputValidationError(`Product ${id} not found`);
      // Keep the id as the payload spells it (prefixed or bare) so the diff does not show an id change.
      return normalizeProduct(product, id);
    },

    verify: async (h, recordId, payload): Promise<VerifyResult> => {
      const product = await getProduct(h, str(payload.id) ?? recordId);
      if (payload.action === 'DELETE') return product ? { ok: false, mismatches: [{ path: [], expected: null, actual: { id: product.id } }] } : { ok: true, mismatches: [] };
      if (!product) return { ok: false, mismatches: [{ path: [], expected: { id: payload.id ?? recordId }, actual: null }] };
      const mismatches: VerifyResult['mismatches'] = [];
      for (const k of PRODUCT_FIELDS) {
        if (payload[k] === undefined) continue;
        if (!sameValue(k, payload[k], product[k])) mismatches.push({ path: [k], expected: payload[k], actual: product[k] ?? null });
      }
      return { ok: mismatches.length === 0, mismatches };
    },

    recordIdOf: (parsed, payload) => z.object({ product: z.object({ id: z.string() }) }).safeParse(parsed).data?.product.id ?? str(payload.id) ?? undefined,

    // Undo an UPDATE (e.g. lift the allocation guard's buyer cap): UPDATE the same fields back to their `before` values.
    undo: {
      canUndo: (op) => {
        const payload = asJsonObject(op.payload);
        if (payload?.action !== 'UPDATE') return { ok: false, reason: 'Only product UPDATEs can be undone (a created product must be removed in Distru).' };
        if (!asJsonObject(op.before)) return { ok: false, reason: 'The product as it was before the update was not recorded.' };
        return productUndoFields(payload).length ? { ok: true } : { ok: false, reason: 'The update changed no restorable product field.' };
      },
      plan: planProductUndo,
    },

    summarize: (payload, before) => {
      const b = before && typeof before === 'object' ? (before as NormalizedProduct) : null;
      const label = b ? [b.sku, b.name].filter((x): x is string => typeof x === 'string' && x.length > 0).join(' ') || b.id : str(payload.name) ?? str(payload.id) ?? 'product';
      if (payload.action === 'DELETE') return `DELETE product ${label}`;
      if (payload.action === 'UPDATE' && payload.maxMenuBuyerOrderQuantity !== undefined) {
        const was = b?.maxMenuBuyerOrderQuantity ?? null;
        const now = payload.maxMenuBuyerOrderQuantity;
        const fmt = (v: unknown) => (v === null || v === undefined ? 'no cap' : `${String(v)} units`);
        return `Per-buyer menu cap on ${label}: ${fmt(was)} → ${fmt(now)} per order (sales reps exempt)`;
      }
      const fields = Object.keys(payload).filter((k) => !['action', 'id', ...DISTRU_INJECTED_FIELDS].includes(k));
      return `${String(payload.action ?? 'CREATE')} product ${label}${fields.length ? ` (${fields.join(', ')})` : ''}`;
    },
  };
}

const asJsonObject = (v: unknown): JsonObject | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : null);

/** Product fields an UPDATE set that an undo restores. */
const productUndoFields = (payload: JsonObject): (typeof PRODUCT_FIELDS)[number][] => PRODUCT_FIELDS.filter((k) => payload[k] !== undefined);

const fmtCap = (v: unknown) => (v === null || v === undefined ? 'no cap' : `${String(v)} units`);

async function planProductUndo(h: McpHookContext, op: CompensableOp, result: OpResult): Promise<McpUndoPlan> {
  const payload = asJsonObject(op.payload) ?? {};
  const before = asJsonObject(op.before) ?? {};
  const id = str(payload.id) ?? result.recordId;
  if (!id) throw new InputValidationError('The product op recorded no product id');
  const product = await getProduct(h, id);
  if (!product) throw new InputValidationError(`Product ${id} no longer exists`);
  const fields = productUndoFields(payload);
  const now = normalizeProduct(product, id);
  const current: JsonObject = {};
  const target: JsonObject = {};
  for (const k of fields) {
    current[k] = now[k] ?? null;
    target[k] = (before[k] as JsonObject[string] | undefined) ?? null;
  }
  const label = [now.sku, now.name].filter((x): x is string => typeof x === 'string' && x.length > 0).join(' ') || id;
  const summary =
    fields.length === 1 && fields[0] === 'maxMenuBuyerOrderQuantity'
      ? `Restore per-buyer menu cap on ${label}: ${fmtCap(current.maxMenuBuyerOrderQuantity)} → ${fmtCap(target.maxMenuBuyerOrderQuantity)}`
      : `Restore ${fields.join(', ')} on product ${label}`;
  const done = fields.every((k) => sameValue(k, current[k], target[k]));
  return { current, target, summary, value: 0, args: done ? null : { action: 'UPDATE', id, ...target } };
}

// ── Inventory adjustments ───────────────────────────────────────────────────────────────────

const AdjustmentResultSchema = z.object({ stockAdjustment: z.object({ id: z.string() }).passthrough() }).passthrough();
const MetrcActivitiesSchema = z
  .object({ items: z.array(z.object({ id: z.string(), status: z.string(), lastError: z.string().nullish(), type: z.string().nullish() }).passthrough()) })
  .passthrough();

/**
 * `distru-adjust-inventory`: a signed delta on a package, batch or product. For a Metrc package Distru
 * saves the change, then syncs it to Metrc in the background; when Metrc rejects it the Distru
 * adjustment stays and the Metrc activity is FAILED. So the write "succeeds" while the state system
 * disagrees, and only a read-back can tell: `verify` passes once the package has no FAILED or QUEUED
 * Metrc activity (a license syncs in creation order, so none left means ours synced too), and
 * otherwise reports the activity status and Metrc's error as mismatches. The op then fails with the
 * Distru record id kept, and a resume re-verifies that record (the executor never adjusts twice:
 * there is no field to stamp a key into, so `find` is absent and the executor record is the dedupe).
 * Batch and product adjustments reach no state system and verify as written.
 */
export function adjustInventoryHooks(): McpToolHooks {
  return {
    recordIdOf: (parsed) => AdjustmentResultSchema.safeParse(parsed).data?.stockAdjustment.id,

    verify: async (h, _recordId, payload): Promise<VerifyResult> => {
      const packageId = str(payload.packageId);
      if (!packageId) return { ok: true, mismatches: [] };
      const parsed = MetrcActivitiesSchema.safeParse(
        await h.read('distru-search-metrc-activities', { packageIds: [packageId], statuses: ['FAILED', 'QUEUED'], sortBy: { field: 'INSERTED_AT', direction: 'DESC' }, limit: 5 }),
      );
      if (!parsed.success) return { ok: false, mismatches: [{ path: ['metrc'], expected: 'Metrc sync history', actual: null }] };
      const open = parsed.data.items[0];
      if (!open) return { ok: true, mismatches: [] };
      return {
        ok: false,
        mismatches: [
          { path: ['metrc', 'status'], expected: 'COMPLETED', actual: open.status },
          ...(open.lastError ? [{ path: ['metrc', 'lastError'], expected: null, actual: open.lastError }] : []),
        ],
      };
    },

    irreversible: "A Distru inventory adjustment can't be edited or undone; adjust again to correct it.",

    summarize: (payload) => {
      const q = num(payload.quantity);
      const target = str(payload.packageId) ? `package ${String(payload.packageId)}` : str(payload.batchId) ? `batch ${String(payload.batchId)}` : `product ${String(payload.productId ?? '?')}`;
      const why = str(payload.complianceReason) ?? str(payload.reason);
      return `Adjust ${target} by ${q !== null && q > 0 ? '+' : ''}${q ?? String(payload.quantity)}${why ? ` (${why})` : ''}${str(payload.packageId) ? ', synced to Metrc' : ''}`;
    },
  };
}

// ── Preset ──────────────────────────────────────────────────────────────────────────────────

/** `intent` from the run, else a description of the governed call; satisfaction 5 unless the run says otherwise. */
export function distruMapIntent({ ctx, tool, kind }: IntentArgs): Record<string, unknown> {
  const run = runContextOf(ctx);
  return {
    intent: run.intent ?? (kind === 'write' ? `Apply a human-approved Ops Agent change (${tool})` : `Ops Agent reading Distru data (${tool})`),
    userSatisfactionEstimate: run.userSatisfactionEstimate ?? 5,
    ...(run.account ? { account: run.account } : {}),
  };
}

export type DistruPreset = Pick<McpConnectorConfig, 'system' | 'description' | 'readOnlyHeader' | 'injectedFields' | 'mapIntent' | 'stripPrefix' | 'table' | 'tools'>;

/** Config fragment for Distru's MCP server: spread into `createMcpConnector({ id, url, auth, ...preset })`. */
export function distruMcpPreset(options: DistruPresetOptions = {}): DistruPreset {
  return {
    system: 'erp',
    description: "Distru ERP via Distru's MCP server: reads pass through; every write (mutate-*, payments, Metrc/QuickBooks syncs, emails) is proposed and needs approval.",
    readOnlyHeader: { ...DISTRU_READ_ONLY_HEADER },
    injectedFields: DISTRU_INJECTED_FIELDS,
    mapIntent: distruMapIntent,
    stripPrefix: 'distru-',
    table: DISTRU_TOOL_TABLE,
    tools: {
      'distru-mutate-purchase-order': purchaseOrderHooks(options),
      'distru-mutate-task': taskHooks(),
      'distru-mutate-product': productHooks(),
      'distru-adjust-inventory': adjustInventoryHooks(),
    },
  };
}

export interface DistruMcpOptions<TId extends string = 'distru_mcp'> extends DistruPresetOptions {
  /** Connector id (default `distru_mcp`, so it can sit next to the REST `distru` connector). */
  id?: TId;
  url?: string;
  key?: string;
  readOnly?: boolean;
  env?: Record<string, string | undefined>;
  fetch?: McpConnectorConfig['fetch'];
}

/** Distru MCP bridge from `DISTRU_MCP_URL` (default https://mcp.distru.com/mcp) + `DISTRU_MCP_KEY`. */
export async function createDistruMcpConnector<const TId extends string = 'distru_mcp'>(options: DistruMcpOptions<TId> = {}): Promise<McpBridge<TId>> {
  const env = options.env ?? process.env;
  const url = options.url ?? env.DISTRU_MCP_URL ?? DISTRU_MCP_DEFAULT_URL;
  const key = options.key ?? env.DISTRU_MCP_KEY;
  if (!key && url === DISTRU_MCP_DEFAULT_URL) throw new Error('DISTRU_MCP_KEY (distru_mcp_…) is required for the hosted Distru MCP server');
  return createMcpConnector({
    // The default literal matches the default type parameter.
    id: options.id ?? ('distru_mcp' as TId),
    url,
    ...(key ? { auth: { bearer: key } } : {}),
    ...(options.readOnly ? { readOnly: true } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...distruMcpPreset(options),
  });
}
