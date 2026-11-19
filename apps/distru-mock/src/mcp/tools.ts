/**
 * Handlers for the mocked Distru MCP tools. Inputs are already validated against the generated zod
 * schemas (src/mcp/schemas.gen.ts); outputs follow each page's Output table (src/mcp/views.ts).
 * Writes go through the same Ops layer as the REST API (same validation, history, webhooks).
 */
import type { z } from 'zod';
import type { Ops } from '../ops';
import { isOnMenu, menuProducts, newMenu, OFFICIAL_BY_CATEGORY, OFFICIAL_COLLECTIONS, OFFICIAL_NAMES, officialCategoryOf } from '../menus';
import { TASK_COLORS } from '../records';
import type { Serializer } from '../serialize';
import { SELF_COMPANY, type Store } from '../store';
import type { ApiErrorItem } from '../upsert';
import type { LotRec, MenuCollectionRec, MenuRec, OrderRec, ProductRec, PurchaseRec, TaskRec } from '../types';
import { fmtNum, money } from '../util';
import { fromMcpId, fromMcpIds, IdError, mid, type IdKind } from './ids';
import type { DistruToolName, TOOL_DEFS } from './schemas.gen';
import { McpViews } from './views';


export interface ToolDetail {
  message: string;
  path: (string | number)[];
}

/** A tool-level failure: returned to the model as an `isError` result with `{ errors: [...] }`. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly details: ToolDetail[] = [],
  ) {
    super(message);
  }
}

export type Args<N extends DistruToolName> = z.infer<(typeof TOOL_DEFS)[N]['input']>;

export interface ToolCtx {
  s: Store;
  ser: Serializer;
  ops: Ops;
  views: McpViews;
  userId: string;
}

type Handler<N extends DistruToolName> = (args: Args<N>, ctx: ToolCtx) => unknown;

// ── shared helpers ─────────────────────────────────────────────────────────────────────────────

const id = (kind: IdKind, v: string, path: string) => fromMcpId(kind, v, [path]);
const ids = (kind: IdKind, v: string[] | undefined, path: string) => fromMcpIds(kind, v, [path]);

function hashArgs(args: Record<string, unknown>): string {
  const { cursor: _c, limit: _l, maxRowsLimit: _m, ...rest } = args;
  void _c;
  void _l;
  void _m;
  return Bun.hash(JSON.stringify(rest)).toString(36);
}

function decodeCursor(cursor: string | undefined, h: string): number {
  if (!cursor) return 0;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { o?: unknown; h?: unknown };
    if (typeof v.o !== 'number' || v.h !== h) throw new Error('mismatch');
    return v.o;
  } catch {
    throw new ToolError('Invalid cursor: a cursor works only with the exact filters and sort that produced it; repeat the same arguments.', [{ message: 'invalid or stale cursor', path: ['cursor'] }]);
  }
}
const encodeCursor = (o: number, h: string) => Buffer.from(JSON.stringify({ o, h })).toString('base64url');

/** Search paging: `{ items, hasMore, nextCursor?, totalCount }`. */
function paged<T, U>(all: T[], args: Record<string, unknown> & { limit?: number; cursor?: string }, map: (t: T) => U) {
  const limit = args.limit ?? 10;
  const h = hashArgs(args);
  const offset = decodeCursor(args.cursor, h);
  const items = all.slice(offset, offset + limit).map(map);
  const hasMore = offset + limit < all.length;
  return { items, hasMore, ...(hasMore ? { nextCursor: encodeCursor(offset + limit, h) } : {}), totalCount: all.length };
}

/** Report paging: `{ rows, meta, nextCursor? }`. */
function report<T>(name: string, all: T[], args: Record<string, unknown> & { cursor?: string; maxRowsLimit?: number }, columns: [string, string][], dateRange: string) {
  const limit = Math.max(1, Math.min(args.maxRowsLimit ?? 500, 5000));
  const h = hashArgs(args);
  const offset = decodeCursor(args.cursor, h);
  const rows = all.slice(offset, offset + limit);
  const hasMore = offset + limit < all.length;
  return {
    ...(hasMore ? { nextCursor: encodeCursor(offset + limit, h) } : {}),
    meta: { report: name, dateRange, rowLimit: limit, offset, rowCount: rows.length, totalRowCount: all.length, truncated: hasMore, columns: columns.map(([key, label]) => ({ key, label })) },
    rows,
  };
}

const TZ = SELF_COMPANY.timezone;

/** UTC offset (minutes) of the company timezone on a given day. */
function tzOffsetMinutes(dateUtc: Date): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(dateUtc).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
}

/** Date filter: YYYY-MM-DD (company timezone; start/end of day) or ISO 8601 with a UTC offset. */
function dateBound(v: string | undefined, end: boolean, path: string): number | undefined {
  if (v === undefined) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const noonUtc = new Date(`${v}T12:00:00Z`);
    const off = tzOffsetMinutes(noonUtc);
    const startUtc = Date.parse(`${v}T00:00:00Z`) - off * 60_000;
    return end ? startUtc + 86_400_000 - 1 : startUtc;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(v) && !Number.isNaN(Date.parse(v))) return Date.parse(v);
  throw new ToolError(`${path}: use YYYY-MM-DD or an ISO 8601 timestamp with a UTC offset`, [{ message: 'invalid date', path: [path] }]);
}

function inRange(iso: string | null, after?: number, before?: number): boolean {
  if (after === undefined && before === undefined) return true;
  if (!iso) return false;
  const t = Date.parse(iso);
  return (after === undefined || t >= after) && (before === undefined || t <= before);
}

/** ISO 8601 with offset (for write inputs); a timestamp with no offset is refused. */
function requireOffset(v: string | undefined, path: string): string | undefined {
  if (v === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(v) || Number.isNaN(Date.parse(v))) {
    throw new ToolError(`${path} must be an ISO 8601 timestamp with a UTC offset, e.g. "2026-09-01T00:00:00-07:00"`, [{ message: 'timestamp with a UTC offset required', path: [path] }]);
  }
  return v;
}

type Sortable = string | number | null | undefined;
function sorted<T>(items: T[], sort: { field: string; direction: 'ASC' | 'DESC' } | undefined, fields: Record<string, (t: T) => Sortable>, def: { field: string; direction: 'ASC' | 'DESC' }): T[] {
  const s = sort ?? def;
  const key = fields[s.field] ?? fields[def.field]!;
  const dir = s.direction === 'ASC' ? 1 : -1;
  return [...items].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1; // nulls last either direction
    if (y == null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
}

/** Substring matches first (by position), then the rest by name similarity (shared letters). */
function ranked<T>(items: T[], search: string, text: (t: T) => string[]): T[] {
  const q = search.toLowerCase();
  return items
    .map((t) => {
      const hay = text(t).map((x) => x.toLowerCase());
      const pos = Math.min(...hay.map((h) => (h.includes(q) ? h.indexOf(q) : Infinity)));
      return { t, pos };
    })
    .filter((x) => x.pos !== Infinity)
    .sort((a, b) => a.pos - b.pos)
    .map((x) => x.t);
}

type CustomFilter = { customFieldId: string; contains?: string; anyOf?: string[]; onOrAfter?: string; onOrBefore?: string };
function customMatch(s: Store, values: Record<string, unknown>, filters: CustomFilter[] | undefined): boolean {
  if (!filters?.length) return true;
  return filters.every((f, i) => {
    const fid = fromMcpId('customField', f.customFieldId, ['customFields', i, 'customFieldId']);
    const def = s.customFields.get(Number(fid));
    const v = values[fid];
    if (!def || v === undefined || v === null) return false;
    if (f.contains !== undefined) return String(v).toLowerCase().includes(f.contains.toLowerCase());
    if (f.anyOf) return Array.isArray(v) ? v.some((x) => f.anyOf!.includes(String(x))) : f.anyOf.includes(String(v));
    const day = String(v).slice(0, 10);
    return (!f.onOrAfter || day >= f.onOrAfter) && (!f.onOrBefore || day <= f.onOrBefore);
  });
}

/** customFields input (`[{customFieldId, value}]`) → REST `custom_data`. */
function customDataFrom(s: Store, list: { customFieldId: string; value: string | string[] }[] | undefined, parent: string): Record<string, unknown> | undefined {
  if (!list) return undefined;
  const out: Record<string, unknown> = {};
  list.forEach((c, i) => {
    const fid = fromMcpId('customField', c.customFieldId, ['customFields', i, 'customFieldId']);
    const def = s.customFields.get(Number(fid));
    if (!def || def.parent_object !== parent) throw new ToolError(`customFields[${i}]: not a ${parent} custom field`, [{ message: 'unknown custom field', path: ['customFields', i, 'customFieldId'] }]);
    const empty = c.value === '' || (Array.isArray(c.value) && !c.value.length);
    out[fid] = empty ? null : def.field_type === 'date' && typeof c.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.value) ? `${c.value}T00:00:00Z` : c.value;
  });
  return out;
}

const num = (v: string | number | undefined, path: (string | number)[]): number | undefined => {
  if (v === undefined) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new ToolError(`${path.join('.')} must be a number`, [{ message: 'must be a number', path }]);
  return n;
};

/** REST validation errors → MCP field paths. */
function restErrors(errors: ApiErrorItem[], names: Record<string, string>, fallback = 'Validation failed'): ToolError {
  const details = errors.map((e) => ({ message: e.message, path: e.pointer.map((p) => (typeof p === 'string' ? (names[p] ?? p) : p)).filter((p) => p !== 'base') }));
  const msg = details.map((d) => (d.path.length ? `${d.path.join('.')}: ${d.message}` : d.message)).join('; ');
  return new ToolError(msg || fallback, details);
}

function orderPaymentStatus(o: OrderRec): 'PAID' | 'NOT_PAID' {
  return o.status === 'COMPLETED' ? 'PAID' : 'NOT_PAID';
}

const PURCHASE_NAMES: Record<string, string> = {
  company_id: 'supplierId',
  location_id: 'intakeLocationId',
  billing_location_id: 'billingLocationId',
  supplier_location_id: 'supplierLocationId',
  order_datetime: 'orderDatetime',
  due_datetime: 'dueDatetime',
  owner_id: 'ownerId',
  items: 'orderItems',
  charges: 'orderCharges',
  product_id: 'productId',
  batch_id: 'batchId',
  received_quantity: 'receivedQuantity',
  custom_data: 'customFields',
  metrc_transfer_id: 'metrcManifestNumber',
  charge_preset_id: 'chargePresetId',
  unit_type: 'unitType',
};

const TASK_NAMES: Record<string, string> = {
  due_datetime: 'dueDate',
  owner_id: 'ownerId',
  location_id: 'locationId',
  order_id: 'salesOrderId',
  purchase_id: 'purchaseOrderId',
  product_id: 'productId',
  batch_id: 'batchId',
  company_id: 'companyId',
  invoice_id: 'invoiceId',
  contact_id: 'contactId',
  assembly_id: 'assemblyId',
  return_id: 'returnId',
  custom_data: 'customFields',
};

// ── purchase order mutation ───────────────────────────────────────────────────────────────────

function mutatePurchaseOrder(a: Args<'distru-mutate-purchase-order'>, ctx: ToolCtx) {
  const { s, ops, views } = ctx;
  if (a.action === 'DELETE') {
    if (!a.id) throw new ToolError('id is required for DELETE', [{ message: 'required for DELETE', path: ['id'] }]);
    const pid = id('purchaseOrder', a.id, 'id');
    const res = ops.deletePurchase(pid, 'MCP');
    if (!res.ok) throw res.status === 404 ? new ToolError(`Purchase order ${a.id} not found`, [{ message: 'not found', path: ['id'] }]) : restErrors(res.errors, PURCHASE_NAMES);
    return { id: mid('purchaseOrder', pid) };
  }
  if (a.metrcManifestNumber) throw new ToolError(`No incoming Metrc manifest ${a.metrcManifestNumber} was found for your licenses`, [{ message: 'manifest not found', path: ['metrcManifestNumber'] }]);
  const body: Record<string, unknown> = {};
  const existing = a.action === 'UPDATE' ? s.purchases.get(a.id ? id('purchaseOrder', a.id, 'id') : '') : undefined;
  if (a.action === 'UPDATE') {
    if (!a.id) throw new ToolError('id is required for UPDATE', [{ message: 'required for UPDATE', path: ['id'] }]);
    if (!existing) throw new ToolError(`Purchase order ${a.id} not found`, [{ message: 'not found', path: ['id'] }]);
    body.id = existing.id;
  }
  const status = a.status ?? (a.action === 'CREATE' ? 'PENDING' : undefined);
  if (status !== undefined) body.status = status;
  const finalStatus = status ?? existing?.status;
  const isDraft = finalStatus === 'DRAFT';
  const finishing = existing?.status === 'DRAFT' && status !== undefined && status !== 'DRAFT';
  const intake = a.intakeLocationId !== undefined ? id('location', a.intakeLocationId, 'intakeLocationId') : undefined;
  const lineLocation = intake ?? existing?.location_id ?? undefined;

  if (a.supplierId !== undefined) body.company_id = id('company', a.supplierId, 'supplierId');
  if (intake !== undefined) body.location_id = intake;
  if (a.billingLocationId !== undefined) body.billing_location_id = id('location', a.billingLocationId, 'billingLocationId');
  else if (!isDraft && (a.action === 'CREATE' || finishing) && lineLocation) body.billing_location_id = existing?.billing_location_id ?? lineLocation;
  if (a.supplierLocationId !== undefined) body.supplier_location_id = id('location', a.supplierLocationId, 'supplierLocationId');
  if (a.ownerId !== undefined) body.owner_id = id('user', a.ownerId, 'ownerId');
  const orderDt = requireOffset(a.orderDatetime, 'orderDatetime');
  if (orderDt !== undefined) body.order_datetime = orderDt;
  else if (!isDraft && (a.action === 'CREATE' || finishing) && !existing?.order_datetime) body.order_datetime = new Date().toISOString();
  const dueDt = requireOffset(a.dueDatetime, 'dueDatetime');
  if (dueDt !== undefined) body.due_datetime = dueDt;
  if (a.description !== undefined) body.description = a.description;
  const custom = customDataFrom(s, a.customFields, 'purchase');
  if (custom) body.custom_data = custom;

  if (a.orderItems !== undefined && a.orderItems !== null) {
    if (existing?.metrc_transfer_id) throw new ToolError('orderItems cannot change once the purchase is matched to a compliance transfer', [{ message: 'not allowed', path: ['orderItems'] }]);
    if (a.action === 'UPDATE' && a.orderItems.length === 0 && !isDraft) throw new ToolError('orderItems: [] is refused unless the purchase is a draft', [{ message: 'empty list refused', path: ['orderItems'] }]);
    body.items = a.orderItems.map((it, i) => {
      if (it.metrcPackageLabel) throw new ToolError('metrcPackageLabel needs metrcManifestNumber', [{ message: 'needs metrcManifestNumber', path: ['orderItems', i, 'metrcPackageLabel'] }]);
      const line: Record<string, unknown> = {};
      if (it.id) line.id = fromMcpId('purchaseOrderItem', it.id, ['orderItems', i, 'id']);
      if (it.productId !== undefined) line.product_id = fromMcpId('product', it.productId, ['orderItems', i, 'productId']);
      if (it.batchId !== undefined) line.batch_id = fromMcpId('batch', it.batchId, ['orderItems', i, 'batchId']);
      const q = num(it.quantity, ['orderItems', i, 'quantity']);
      const pr = num(it.price, ['orderItems', i, 'price']);
      const rq = num(it.receivedQuantity, ['orderItems', i, 'receivedQuantity']);
      if (q !== undefined) line.quantity = q;
      if (pr !== undefined) line.price = pr;
      if (rq !== undefined) line.received_quantity = rq;
      if (!it.id) {
        if (!lineLocation && !isDraft) throw new ToolError('intakeLocationId is required to add lines', [{ message: 'required to add lines', path: ['intakeLocationId'] }]);
        if (lineLocation) line.location_id = lineLocation;
      } else if (intake !== undefined || finishing) line.location_id = lineLocation;
      return line;
    });
  } else if (existing && (finishing || (intake !== undefined && existing.status === 'DRAFT'))) {
    // a draft's lines move with its intake location (and take it when the draft is finished)
    body.items = existing.items.map((it) => ({ id: it.id, ...(lineLocation ? { location_id: lineLocation } : {}) }));
  }
  if (a.orderCharges !== undefined && a.orderCharges !== null) {
    if (existing?.metrc_transfer_id) throw new ToolError('orderCharges cannot change once the purchase is matched to a compliance transfer', [{ message: 'not allowed', path: ['orderCharges'] }]);
    body.charges = a.orderCharges.map((c, i) => {
      const ch: Record<string, unknown> = {};
      if (c.id) ch.id = fromMcpId('charge', c.id, ['orderCharges', i, 'id']);
      if (c.chargePresetId) ch.charge_preset_id = c.chargePresetId;
      if (c.name !== undefined) ch.name = c.name;
      if (c.type !== undefined) ch.type = c.type;
      if (c.unitType !== undefined) ch.unit_type = c.unitType;
      const pct = num(c.percent, ['orderCharges', i, 'percent']);
      const price = num(c.price, ['orderCharges', i, 'price']);
      if (pct !== undefined) ch.percent = Math.abs(pct);
      if (price !== undefined) ch.price = Math.abs(price);
      return ch;
    });
  }
  const res = ops.upsertPurchase(body, 'MCP');
  if (!res.ok) throw res.status === 404 ? new ToolError(`Purchase order ${a.id} not found`, [{ message: 'not found', path: ['id'] }]) : restErrors(res.errors, PURCHASE_NAMES);
  return { purchaseOrder: views.purchaseOrder(res.record, { items: true, charges: true }) };
}

function purchaseTotal(ctx: ToolCtx, p: PurchaseRec) {
  return ctx.ser.purchaseTotal(p);
}

// ── task mutation ─────────────────────────────────────────────────────────────────────────────

function mutateTask(a: Args<'distru-mutate-task'>, ctx: ToolCtx) {
  const { ops, views, s } = ctx;
  if (a.action !== 'CREATE' && !a.id) throw new ToolError(`id is required for ${a.action}`, [{ message: `required for ${a.action}`, path: ['id'] }]);
  const tid = a.id ? id('task', a.id, 'id') : undefined;
  if (a.action === 'DELETE') {
    const res = ops.deleteTask(tid!, 'MCP');
    if (!res.ok) throw new ToolError(`Task ${a.id} not found`, [{ message: 'not found', path: ['id'] }]);
    return { id: mid('task', tid!) };
  }
  if (a.action === 'CREATE') {
    if (!a.name) throw new ToolError('name is required for CREATE', [{ message: 'required for CREATE', path: ['name'] }]);
    if (!a.dueDate) throw new ToolError('dueDate is required for CREATE', [{ message: 'required for CREATE', path: ['dueDate'] }]);
  }
  const body: Record<string, unknown> = {};
  if (tid) body.id = tid;
  if (a.name !== undefined) body.name = a.name;
  if (a.description !== undefined) body.description = a.description;
  if (a.status !== undefined) body.status = a.status;
  else if (a.action === 'CREATE') body.status = 'ACTIVE';
  const due = requireOffset(a.dueDate, 'dueDate');
  if (due !== undefined) body.due_datetime = due;
  if (a.ownerId !== undefined) body.owner_id = a.ownerId === null ? null : id('user', a.ownerId, 'ownerId');
  if (a.locationId !== undefined) body.location_id = a.locationId === null ? null : id('location', a.locationId, 'locationId');
  if (a.color !== undefined) body.color = a.color === null ? null : TASK_COLORS[a.color];
  const links: [keyof typeof a, string, IdKind][] = [
    ['salesOrderId', 'order_id', 'salesOrder'],
    ['purchaseOrderId', 'purchase_id', 'purchaseOrder'],
    ['productId', 'product_id', 'product'],
    ['batchId', 'batch_id', 'batch'],
    ['companyId', 'company_id', 'company'],
    ['invoiceId', 'invoice_id', 'invoice'],
    ['assemblyId', 'assembly_id', 'assembly'],
  ];
  for (const [k, rest, kind] of links) {
    const v = a[k];
    if (typeof v === 'string') body[rest] = id(kind, v, String(k));
  }
  if (a.contactId) body.contact_id = a.contactId;
  if (a.returnId) body.return_id = a.returnId;
  const custom = customDataFrom(s, a.customFields, 'task');
  if (custom) body.custom_data = custom;
  const res = ops.upsertTask(body, 'MCP');
  if (!res.ok) throw res.status === 404 ? new ToolError(`Task ${a.id} not found`, [{ message: 'not found', path: ['id'] }]) : restErrors(res.errors, TASK_NAMES);
  return { task: views.task(res.record) };
}

// ── PDFs ──────────────────────────────────────────────────────────────────────────────────────

function emailPdf(a: Args<'distru-email-pdf'>, ctx: ToolCtx) {
  const { s, ops } = ctx;
  const to = [...new Set(a.emailAddresses.flatMap((e) => e.split(',')).map((e) => e.trim()).filter(Boolean))];
  if (!to.length) throw new ToolError('emailAddresses needs at least one address', [{ message: 'required', path: ['emailAddresses'] }]);
  const bad = to.find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  if (bad) throw new ToolError(`emailAddresses: ${bad} is not a valid email address`, [{ message: 'invalid email', path: ['emailAddresses'] }]);
  const notFound = (what: string) => new ToolError(`${what} ${a.id} not found`, [{ message: 'not found', path: ['id'] }]);
  const noCoa = () => new ToolError('No lab result file (COA) was found for this document', [{ message: 'no lab result file', path: ['id'] }]);
  let recordId: string;
  let name: string;
  switch (a.document) {
    case 'PURCHASE_ORDER': {
      const p = s.purchases.get(id('purchaseOrder', a.id, 'id'));
      if (!p) throw notFound('Purchase order');
      if (p.status === 'DRAFT') throw new ToolError('Draft purchase orders have no PDF: finish the draft first', [{ message: 'draft refused', path: ['id'] }]);
      recordId = p.id;
      name = p.purchase_number;
      break;
    }
    case 'SALES_ORDER':
    case 'SALES_ORDER_COA': {
      const o = s.orders.get(id('salesOrder', a.id, 'id'));
      if (!o) throw notFound('Sales order');
      if (a.document === 'SALES_ORDER_COA' && !o.items.some((i) => i.batch_id && [...s.testResults.values()].some((t) => t.batch_id === i.batch_id))) throw noCoa();
      recordId = o.id;
      name = o.order_number;
      break;
    }
    case 'BATCH_COA': {
      const b = s.batches.get(id('batch', a.id, 'id'));
      if (!b) throw notFound('Batch');
      if (![...s.testResults.values()].some((t) => t.batch_id === b.id)) throw noCoa();
      recordId = b.id;
      name = b.batch_number;
      break;
    }
    case 'PACKAGE_COA': {
      const l = s.lots.get(id('package', a.id, 'id'));
      if (!l || !l.compliance_label) throw notFound('Package');
      if (!l.batch_id || ![...s.testResults.values()].some((t) => t.batch_id === l.batch_id)) throw noCoa();
      recordId = l.id;
      name = l.compliance_label;
      break;
    }
    case 'TEST_RESULT_COA': {
      const t = s.testResults.get(id('testResult', a.id, 'id'));
      if (!t) throw notFound('Test result');
      recordId = t.id;
      name = t.name;
      break;
    }
    case 'INVOICE':
    case 'INVOICE_COA':
      id('invoice', a.id, 'id');
      throw notFound('Invoice');
    case 'ASSEMBLY':
      id('assembly', a.id, 'id');
      throw notFound('Assembly');
    case 'METRC_MANIFEST':
      throw new ToolError('No working Metrc API key for the license of this manifest (mock: Metrc manifests are not available)', [{ message: 'no Metrc key', path: ['id'] }]);
  }
  ops.emailPdf({ document: a.document, recordId, recordName: name, to }, 'MCP');
  return { emailedTo: to };
}


// ── DistruCommerce menus + products ─────────────────────────────────────────────────────────────

/** Company settings the mock reports in distru-get-me (they gate some menu options). */
const COMPANY_SETTINGS = { allowNegativeAvailableQuantity: false, sellingByTotalThc: false };

function mutateMenu(a: Args<'distru-mutate-menu'>, ctx: ToolCtx) {
  const { s, ops, views } = ctx;
  const fail = (path: string, message: string): never => {
    throw new ToolError(`${path}: ${message}`, [{ message, path: [path] }]);
  };
  let before: MenuRec | null = null;
  let m: MenuRec;
  if (a.action === 'UPDATE') {
    if (!a.id) fail('id', 'required for UPDATE');
    const existing = s.menus.get(id('menu', a.id!, 'id'));
    if (!existing) throw new ToolError(`Menu ${a.id} not found`, [{ message: 'not found', path: ['id'] }]);
    before = structuredClone(existing);
    m = structuredClone(existing);
  } else {
    if (!a.name) fail('name', 'required for CREATE');
    if (!a.locationIds?.length) fail('locationIds', 'required for CREATE');
    m = newMenu(s, { name: a.name!, location_ids: [] });
  }
  const others = [...s.menus.values()].filter((x) => x.id !== m.id);
  if (a.name !== undefined) {
    if (!a.name.trim()) fail('name', "can't be blank");
    if (others.some((x) => x.name.toLowerCase() === a.name!.trim().toLowerCase())) fail('name', 'is already used by another menu');
    m.name = a.name.trim();
    if (a.action === 'CREATE' && a.externalName === undefined) m.external_name = m.name;
  }
  if (a.externalName !== undefined) m.external_name = a.externalName;
  if (a.urlSuffix !== undefined) {
    if (!/^[A-Za-z0-9-]+$/.test(a.urlSuffix)) fail('urlSuffix', 'letters, digits and dashes only');
    if (others.some((x) => x.url_suffix.toLowerCase() === a.urlSuffix!.toLowerCase())) fail('urlSuffix', 'is already used by another menu');
    m.url_suffix = a.urlSuffix;
  } else if (a.action === 'CREATE') {
    let suffix = m.url_suffix;
    for (let n = 2; others.some((x) => x.url_suffix === suffix); n++) suffix = `${m.url_suffix}-${n}`;
    m.url_suffix = suffix;
  }
  if (a.ownerId !== undefined) m.owner_id = a.ownerId === null ? null : (s.users.get(id('user', a.ownerId, 'ownerId'))?.id ?? fail('ownerId', 'user not found'));
  if (a.active !== undefined) m.active = a.active;
  if (a.visibility !== undefined) {
    if (a.visibility === 'PASSCODE_PROTECTED' && m.visibility !== 'PASSCODE_PROTECTED' && a.passcode === undefined && !m.passcode) fail('passcode', 'needed when visibility turns PASSCODE_PROTECTED');
    m.visibility = a.visibility;
  }
  if (a.passcode !== undefined) {
    if (!/^[A-Za-z0-9]{4,}$/.test(a.passcode)) fail('passcode', 'at least 4 letters or digits');
    m.passcode = a.passcode;
  }
  if (a.locationIds !== undefined) {
    const locs = a.locationIds.map((l, i) => fromMcpId('location', l, ['locationIds', i]));
    locs.forEach((l, i) => {
      if (!s.ownLocationIds.includes(l)) throw new ToolError(`locationIds[${i}]: not one of your locations`, [{ message: 'not one of your locations', path: ['locationIds', i] }]);
    });
    if (!locs.length) fail('locationIds', 'needs at least one location');
    m.location_ids = [...new Set(locs)];
  }
  const set = <K extends keyof MenuRec>(k: K, v: MenuRec[K] | undefined) => {
    if (v !== undefined) m[k] = v;
  };
  set('allow_partner_orders', a.allowPartnerOrders);
  set('minimum_order_lead_time_days', a.minimumOrderLeadTimeDays);
  if (a.minimumOrderLeadTimeDays !== undefined && a.minimumOrderLeadTimeDays < 0) fail('minimumOrderLeadTimeDays', 'must be 0 or more');
  set('available_delivery_days', a.availableDeliveryDays);
  set('buyer_can_select_delivery_date', a.buyerCanSelectDeliveryDate);
  set('sell_by_case_only', a.sellByCaseOnly);
  if (a.allowCustomersToOverOrder === true && !COMPANY_SETTINGS.allowNegativeAvailableQuantity) fail('allowCustomersToOverOrder', "needs the company setting 'Allow Negative Available Quantity'");
  set('allow_customers_to_over_order', a.allowCustomersToOverOrder);
  if (a.defaultOrderStatus === 'Processing' && !COMPANY_SETTINGS.allowNegativeAvailableQuantity) fail('defaultOrderStatus', "Processing needs the company setting 'Allow Negative Available Quantity'");
  set('default_order_status', a.defaultOrderStatus);
  set('buyer_default_order_owner_mode', a.buyerDefaultOrderOwnerMode);
  set('seller_default_order_owner_mode', a.sellerDefaultOrderOwnerMode);
  if (a.buyerDefaultOrderOwnerId !== undefined) m.buyer_default_order_owner_id = id('user', a.buyerDefaultOrderOwnerId, 'buyerDefaultOrderOwnerId');
  if (a.sellerDefaultOrderOwnerId !== undefined) m.seller_default_order_owner_id = id('user', a.sellerDefaultOrderOwnerId, 'sellerDefaultOrderOwnerId');
  for (const [mode, owner, path] of [
    [m.buyer_default_order_owner_mode, m.buyer_default_order_owner_id, 'buyerDefaultOrderOwnerId'],
    [m.seller_default_order_owner_mode, m.seller_default_order_owner_id, 'sellerDefaultOrderOwnerId'],
  ] as const) {
    if (mode === 'SPECIFIC_USER' && (!owner || !s.users.has(owner))) fail(path, 'a user is required with SPECIFIC_USER');
  }
  if (m.buyer_default_order_owner_mode !== 'SPECIFIC_USER') m.buyer_default_order_owner_id = null;
  if (m.seller_default_order_owner_mode !== 'SPECIFIC_USER') m.seller_default_order_owner_id = null;
  set('allow_sales_reps_to_override_net_terms', a.allowSalesRepsToOverrideNetTerms);
  if (a.autoCreateInvoiceForSalesRepOrders === true && m.default_order_status !== 'Processing') fail('autoCreateInvoiceForSalesRepOrders', 'only with defaultOrderStatus Processing');
  set('auto_create_invoice_for_sales_rep_orders', a.autoCreateInvoiceForSalesRepOrders);
  set('show_inventory_levels', a.showInventoryLevels);
  set('show_products_with_no_inventory_mode', a.showProductsWithNoInventoryMode);
  set('hide_prices_mode', a.hidePricesMode);
  set('hide_original_price_when_price_tier_applied', a.hideOriginalPriceWhenPriceTierApplied);
  if (a.allowSellingByPotency === true && !COMPANY_SETTINGS.sellingByTotalThc) fail('allowSellingByPotency', "needs the company setting 'Enable Selling by Total THC %'");
  set('allow_selling_by_potency', a.allowSellingByPotency);
  set('potency_official_product_category_ids', a.potencyOfficialProductCategoryIds);
  set('show_coa', a.showCoa);
  set('show_expiration_date', a.showExpirationDate);
  set('show_package_date', a.showPackageDate);
  set('show_tac', a.showTac);
  set('show_total_cbd', a.showTotalCbd);
  set('allow_buyers_to_request_trade_samples', a.allowBuyersToRequestTradeSamples);
  if (a.allowBuyersToRequestTradeSamples === true && before && !before.allow_buyers_to_request_trade_samples) m.restrict_trade_sample_request_to_products_in_cart = false;
  if (a.restrictTradeSampleRequestToProductsInCart !== undefined) {
    if (a.restrictTradeSampleRequestToProductsInCart && !m.allow_buyers_to_request_trade_samples) fail('restrictTradeSampleRequestToProductsInCart', 'only while allowBuyersToRequestTradeSamples');
    m.restrict_trade_sample_request_to_products_in_cart = a.restrictTradeSampleRequestToProductsInCart;
  }
  set('send_internal_order_notifications', a.sendInternalOrderNotifications);
  if (a.internalOrderNotificationRecipientIds !== undefined) {
    m.internal_order_notification_recipient_ids = a.internalOrderNotificationRecipientIds.map((u, i) => {
      const uid = fromMcpId('user', u, ['internalOrderNotificationRecipientIds', i]);
      if (!s.users.has(uid)) throw new ToolError(`internalOrderNotificationRecipientIds[${i}]: user not found`, [{ message: 'user not found', path: ['internalOrderNotificationRecipientIds', i] }]);
      return uid;
    });
  }
  if (a.minimumOrderSubtotal !== undefined) {
    if (a.minimumOrderSubtotal !== null && m.hide_prices_mode === 'HIDE_FOR_EVERYONE') fail('minimumOrderSubtotal', 'refused while hidePricesMode is HIDE_FOR_EVERYONE');
    m.minimum_order_subtotal = a.minimumOrderSubtotal === null ? null : num(a.minimumOrderSubtotal, ['minimumOrderSubtotal'])!;
  }
  if (m.hide_prices_mode === 'HIDE_FOR_EVERYONE') m.minimum_order_subtotal = null;
  if (a.collections !== undefined && a.collections !== null) {
    const now = s.nowIso();
    m.collections = a.collections.map((c, i): MenuCollectionRec => {
      const prev = c.id ? m.collections.find((x) => x.id === fromMcpId('menuCollection', c.id!, ['collections', i, 'id'])) : undefined;
      if (c.id && !prev) throw new ToolError(`collections[${i}].id: not a collection of this menu`, [{ message: 'not found', path: ['collections', i, 'id'] }]);
      if (!prev && !c.name) throw new ToolError(`collections[${i}].name: required for a new collection`, [{ message: 'required for a new collection', path: ['collections', i, 'name'] }]);
      const thc = c.thcRange === undefined ? prev?.thc_range ?? null : c.thcRange === null ? null : { ...(c.thcRange.min !== undefined ? { min: String(c.thcRange.min) } : {}), ...(c.thcRange.max !== undefined ? { max: String(c.thcRange.max) } : {}), unit: c.thcRange.unit };
      return {
        id: prev?.id ?? s.newId(),
        name: c.name ?? prev!.name,
        is_hidden: c.isHidden ?? prev?.is_hidden ?? false,
        only_featured_products: c.onlyFeaturedProducts ?? prev?.only_featured_products ?? false,
        official_product_category_ids: c.officialProductCategoryIds ?? prev?.official_product_category_ids ?? [],
        product_category_ids: c.productCategoryIds?.map((x, j) => fromMcpId('category', x, ['collections', i, 'productCategoryIds', j])) ?? prev?.product_category_ids ?? [],
        strain_ids: c.strainIds ?? prev?.strain_ids ?? [],
        strain_types: c.strainTypes ?? prev?.strain_types ?? [],
        thc_range: thc,
        inserted_datetime: prev?.inserted_datetime ?? now,
        updated_datetime: now,
      };
    });
  }
  if (a.officialCollections !== undefined && a.officialCollections !== null) {
    m.official_collection_names = Object.fromEntries(a.officialCollections.map((o) => [o.officialCollectionName, o.customName]));
  }
  if (a.copyProductsFromMenuId !== undefined) {
    if (a.action !== 'CREATE') fail('copyProductsFromMenuId', 'CREATE only');
    const from = id('menu', a.copyProductsFromMenuId, 'copyProductsFromMenuId');
    if (!s.menus.has(from)) fail('copyProductsFromMenuId', 'menu not found');
    for (const p of s.products.values()) if (p.menu_visibility === 'INCLUDE_IN_SELECT' && p.menu_ids?.includes(from)) p.menu_ids = [...p.menu_ids, m.id];
  }
  ops.saveMenu(before, m, 'MCP');
  return { menu: views.menuSettings(m, { collections: true }) };
}

const UNMODELLED_PRODUCT_FIELDS = [
  'upc',
  'subcategoryId',
  'brandId',
  'groupId',
  'ownerId',
  'wholesaleUnitPrice',
  'unitNetWeight',
  'unitServingSize',
  'unitNetWeightAndServingSizeUnitTypeId',
  'grossWeight',
  'grossWeightUnitTypeId',
  'quickbooksSalesItemId',
  'quickbooksPurchaseItemId',
  'tagIds',
  'customFields',
] as const;

function mutateProduct(a: Args<'distru-mutate-product'>, ctx: ToolCtx) {
  const { s, ops, views } = ctx;
  const fail = (path: string, message: string): never => {
    throw new ToolError(`${path}: ${message}`, [{ message, path: [path] }]);
  };
  for (const k of UNMODELLED_PRODUCT_FIELDS) if (a[k] !== undefined && a[k] !== null) fail(k, 'is not modelled by the Distru mock');
  if (a.action !== 'CREATE' && !a.id) fail('id', `required for ${a.action}`);
  const existing = a.id ? s.products.get(id('product', a.id, 'id')) : undefined;
  if (a.action !== 'CREATE' && !existing) throw new ToolError(`Product ${a.id} not found`, [{ message: 'not found', path: ['id'] }]);
  if (a.action === 'DELETE') {
    const p = existing!;
    if (s.quantityActive(p.id) > 0) fail('id', 'has inventory; adjust it to zero or mark the product inactive instead');
    const open = [...s.orders.values()].some((o) => o.items.some((i) => i.product_id === p.id)) || [...s.purchases.values()].some((x) => x.items.some((i) => i.product_id === p.id));
    if (open) fail('id', 'is on sales or purchase orders; mark it inactive instead');
    ops.saveProduct(p, null, 'MCP');
    return { id: mid('product', p.id) };
  }
  const now = s.nowIso();
  if (a.action === 'CREATE') {
    for (const k of ['name', 'sku', 'categoryId', 'unitTypeId', 'vendorId', 'unitPrice', 'inventoryTrackingMethod'] as const) if (a[k] === undefined) fail(k, 'required for CREATE');
    if (a.unitTypeId !== 'ut_each' && a.unitTypeId !== 'unit-each') fail('unitTypeId', 'the mock only has the Each unit type (ut_each)');
  }
  const before = existing ? structuredClone(existing) : null;
  const p: ProductRec = existing
    ? structuredClone(existing)
    : {
        id: s.newId(),
        sku: '',
        name: '',
        description: null,
        category_id: '',
        vendor_id: '',
        strain: null,
        unit_cost: 0,
        unit_price: 0,
        msrp: 0,
        units_per_case: null,
        threshold_min: null,
        threshold_max: null,
        tracking: a.inventoryTrackingMethod ?? 'PRODUCT',
        is_active: true,
        total_thc: null,
        total_cbd: null,
        cannabinoid_unit: null,
        inserted_datetime: now,
        updated_datetime: now,
      };
  const others = [...s.products.values()].filter((x) => x.id !== p.id);
  const money2 = (v: string | number | null | undefined, path: string) => (v === undefined || v === null ? v : num(v, [path])!);
  if (a.name !== undefined) {
    if (!a.name.trim() || /[:[\]]/.test(a.name)) fail('name', "can't be blank or contain : [ ]");
    if (others.some((x) => x.name.toLowerCase() === a.name!.trim().toLowerCase())) fail('name', 'must be unique within your company');
    p.name = a.name.trim();
  }
  if (a.sku !== undefined) {
    if (!a.sku.trim()) fail('sku', "can't be blank");
    if (others.some((x) => x.sku.toLowerCase() === a.sku!.trim().toLowerCase())) fail('sku', 'must be unique within your company');
    p.sku = a.sku.trim();
  }
  if (a.categoryId !== undefined) p.category_id = s.categories.get(id('category', a.categoryId, 'categoryId'))?.id ?? fail('categoryId', 'category not found');
  if (a.vendorId !== undefined) p.vendor_id = s.companies.get(id('company', a.vendorId, 'vendorId'))?.id ?? fail('vendorId', 'company not found');
  if (a.inventoryTrackingMethod !== undefined && existing && a.inventoryTrackingMethod !== existing.tracking) fail('inventoryTrackingMethod', 'cannot change after CREATE');
  if (a.description !== undefined) p.description = a.description;
  if (a.descriptionMarkdown !== undefined && a.description === undefined && a.descriptionMarkdown !== null) p.description = a.descriptionMarkdown;
  if (a.externalName !== undefined) p.external_name = a.externalName;
  if (a.strainId !== undefined) {
    if (a.strainId === null) p.strain = null;
    else p.strain = [...s.products.values()].find((x) => x.strain?.id === a.strainId)?.strain ?? fail('strainId', 'strain not found');
  }
  const price = money2(a.unitPrice, 'unitPrice');
  if (price !== undefined && price !== null) p.unit_price = price;
  const cost = money2(a.unitCost, 'unitCost');
  if (cost !== undefined) p.unit_cost = cost ?? 0;
  const msrp = money2(a.msrp, 'msrp');
  if (msrp !== undefined) p.msrp = msrp ?? 0;
  const perCase = money2(a.unitsPerCase, 'unitsPerCase');
  if (perCase !== undefined) {
    if (perCase !== null && perCase <= 0) fail('unitsPerCase', 'must be greater than zero');
    p.units_per_case = perCase;
  }
  if (a.maxMenuBuyerOrderQuantity !== undefined) {
    if (a.maxMenuBuyerOrderQuantity !== null && a.maxMenuBuyerOrderQuantity < 1) fail('maxMenuBuyerOrderQuantity', 'must be at least 1 (null = no cap)');
    p.max_menu_buyer_order_quantity = a.maxMenuBuyerOrderQuantity;
  }
  if (a.totalCannabinoidUnit !== undefined) p.cannabinoid_unit = a.totalCannabinoidUnit;
  const thc = money2(a.totalThc, 'totalThc');
  const cbd = money2(a.totalCbd, 'totalCbd');
  if (thc !== undefined) p.total_thc = thc;
  if (cbd !== undefined) p.total_cbd = cbd;
  if ((p.total_thc != null || p.total_cbd != null) && !p.cannabinoid_unit) fail('totalCannabinoidUnit', 'required while totalThc or totalCbd is set');
  for (const [v, path] of [
    [p.total_thc, 'totalThc'],
    [p.total_cbd, 'totalCbd'],
  ] as const) {
    if (v != null && (v < 0 || (p.cannabinoid_unit === 'PERCENT' && v > 100))) fail(path, 'non-negative, at most 100 for PERCENT');
  }
  const tmin = money2(a.quantityAvailableThresholdMin, 'quantityAvailableThresholdMin');
  const tmax = money2(a.quantityAvailableThresholdMax, 'quantityAvailableThresholdMax');
  if (tmin !== undefined) p.threshold_min = tmin;
  if (tmax !== undefined) p.threshold_max = tmax;
  if (p.threshold_min != null && p.threshold_max != null && p.threshold_min >= p.threshold_max) fail('quantityAvailableThresholdMin', 'must be below quantityAvailableThresholdMax');
  if (a.isInactive !== undefined) p.is_active = !a.isInactive;
  if (a.isFeatured !== undefined) p.is_featured = a.isFeatured;
  if (a.menuVisibility !== undefined) {
    p.menu_visibility = a.menuVisibility;
    if (a.menuVisibility === 'INCLUDE_IN_SELECT') {
      if (!a.menus) fail('menus', 'required with menuVisibility INCLUDE_IN_SELECT');
      p.menu_ids = a.menus!.map((x, i) => {
        const mId = fromMcpId('menu', x, ['menus', i]);
        if (!s.menus.has(mId)) throw new ToolError(`menus[${i}]: menu not found`, [{ message: 'menu not found', path: ['menus', i] }]);
        return mId;
      });
    } else p.menu_ids = [];
  }
  ops.saveProduct(before, p, 'MCP');
  return { product: views.productFull(p, { tags: true }) };
}

const MENU_HANDLERS = {
  'distru-search-menus': (a: Args<'distru-search-menus'>, { s, views }: ToolCtx) => {
    const idList = ids('menu', a.ids, 'ids');
    const status = a.status ?? 'ACTIVE';
    let list = [...s.menus.values()].filter((m) => {
      if (status === 'ACTIVE' && !m.active) return false;
      if (status === 'INACTIVE' && m.active) return false;
      if (idList && !idList.includes(m.id)) return false;
      if (a.visibility && m.visibility !== a.visibility) return false;
      return true;
    });
    if (a.search) list = ranked(list, a.search, (m) => [m.name, m.external_name]);
    else list = sorted(list, a.sortBy, { INSERTED_AT: (m) => m.inserted_datetime, NAME: (m) => m.name.toLowerCase(), UPDATED_AT: (m) => m.updated_datetime }, { field: 'UPDATED_AT', direction: 'DESC' });
    return paged(list, a, (m) => views.menuRow(m));
  },

  'distru-get-menu-settings': (a: Args<'distru-get-menu-settings'>, { s, views }: ToolCtx) => {
    const m = s.menus.get(id('menu', a.id, 'id'));
    return { menu: m ? views.menuSettings(m, { collections: a.includeCollections }) : null };
  },

  'distru-search-menu-products': (a: Args<'distru-search-menu-products'>, { s, views }: ToolCtx) => {
    const m = s.menus.get(id('menu', a.menuId, 'menuId'));
    if (!m) throw new ToolError(`Menu ${a.menuId} not found`, [{ message: 'not found', path: ['menuId'] }]);
    const productIds = ids('product', a.productIds, 'productIds');
    const cats = ids('category', a.productCategoryIds, 'productCategoryIds');
    const none = [a.productSubcategoryIds, a.brandIds, a.productGroupIds].some((x) => x?.length);
    const shown = menuProducts(s, m);
    let list = shown.filter((p) => {
      if (none) return false;
      if (productIds && !productIds.includes(p.id)) return false;
      const official = officialCategoryOf(s, p);
      if (a.officialProductCategories && !a.officialProductCategories.includes(official)) return false;
      // a category narrows only its own category type
      if (cats) {
        const catTypes = new Set(cats.map((c) => OFFICIAL_BY_CATEGORY[s.categories.get(c)?.name ?? ''] ?? 'OTHER'));
        if (catTypes.has(official) && !cats.includes(p.category_id)) return false;
        if (!a.officialProductCategories && !cats.includes(p.category_id)) return false;
      }
      if (a.strainTypes && (!p.strain || !a.strainTypes.includes(p.strain.strain_type))) return false;
      if (a.strainIds && (!p.strain || !a.strainIds.includes(p.strain.id))) return false;
      return true;
    });
    if (a.search) {
      list = ranked(list, a.search, (p) => [p.external_name || p.name, p.sku, p.strain?.name ?? '', s.categories.get(p.category_id)?.name ?? '', p.strain?.strain_type ?? '', officialCategoryOf(s, p)]);
    } else {
      list = sorted(list, a.sortBy, { INSERTED_AT: (p) => p.inserted_datetime, PRODUCT_NAME: (p) => (p.external_name || p.name).toLowerCase(), UPDATED_AT: (p) => p.updated_datetime }, { field: 'UPDATED_AT', direction: 'DESC' });
    }
    const out: Record<string, unknown> = paged(list, a, (p) => views.menuProduct(m, p));
    if (!m.active) out.note = 'This menu is inactive: buyers see nothing on it.';
    if (a.includeFilterOptions) {
      const officials = [...new Set(shown.map((p) => officialCategoryOf(s, p)))];
      const strains = new Map(shown.filter((p) => p.strain).map((p) => [p.strain!.id, p.strain!.name]));
      out.filterOptions = {
        officialProductCategories: officials.map((o) => ({
          id: o,
          name: OFFICIAL_NAMES[o],
          productCategoryIds: [...new Set(shown.filter((p) => officialCategoryOf(s, p) === o).map((p) => p.category_id))].map((c) => ({ id: mid('category', c), name: s.categories.get(c)?.name ?? '' })),
        })),
        strainTypes: [...new Set(shown.map((p) => p.strain?.strain_type).filter(Boolean))].map((t) => ({ id: t!, name: t!.replace(/_/g, ' ').toLowerCase() })),
        strainIds: [...strains].map(([sid, name]) => ({ id: sid, name })),
        brandIds: [],
        productGroupIds: [],
      };
    }
    return out;
  },

  'distru-search-menu-collections': (a: Args<'distru-search-menu-collections'>, { s, views }: ToolCtx) => {
    const m = s.menus.get(id('menu', a.menuId, 'menuId'));
    if (!m) throw new ToolError(`Menu ${a.menuId} not found`, [{ message: 'not found', path: ['menuId'] }]);
    type Col = { id: string; name: string; customName: string | null; official: boolean; position: number; products: ProductRec[]; updated: string; inserted: string };
    const officialSlug = (n: string) => `official-${n.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const customs: Col[] = m.collections
      .filter((c) => !c.is_hidden)
      .map((c, i) => ({ id: mid('menuCollection', c.id), name: c.name, customName: null, official: false, position: i, products: views.collectionProducts(m, { rec: c }), updated: c.updated_datetime, inserted: c.inserted_datetime }));
    const officials: Col[] = OFFICIAL_COLLECTIONS.filter((n) => n !== 'Recently Ordered' || a.customerId).map((n, i) => ({
      id: mid('menuCollection', officialSlug(n)),
      name: n,
      customName: m.official_collection_names[n] ?? null,
      official: true,
      position: customs.length + i,
      products: n === 'Recently Ordered' && a.customerId ? recentlyOrdered(s, m, id('company', a.customerId, 'customerId')) : views.collectionProducts(m, { official: n }),
      updated: m.updated_datetime,
      inserted: m.inserted_datetime,
    }));
    let all = [...customs, ...officials].filter((c) => c.official ? c.products.length > 0 || c.name === 'All Products' : true);
    if (a.collectionId) {
      const cid = a.collectionId.startsWith('mcol_') ? a.collectionId : `mcol_${a.collectionId}`;
      all = all.filter((c) => c.id === cid);
      if (!all.length) throw new ToolError(`Collection ${a.collectionId} not found on this menu`, [{ message: 'not found', path: ['collectionId'] }]);
    } else {
      all = sorted(all, a.sortBy, { INSERTED_AT: (c) => c.inserted, NAME: (c) => (c.customName ?? c.name).toLowerCase(), POSITION: (c) => c.position, UPDATED_AT: (c) => c.updated }, { field: 'POSITION', direction: 'ASC' });
    }
    const withProducts = !!a.collectionId || !!a.includeProducts;
    const productLimit = a.productLimit ?? 120;
    return paged(all, a, (c) => ({
      id: c.id,
      name: c.name,
      customName: c.customName,
      official: c.official,
      position: c.position,
      productCount: c.products.length,
      ...(withProducts ? { products: [...c.products].sort((x, y) => (x.external_name || x.name).localeCompare(y.external_name || y.name)).slice(0, productLimit).map((p) => views.menuProduct(m, p)) } : {}),
    }));
  },

  'distru-mutate-menu': mutateMenu,
  'distru-mutate-product': mutateProduct,
};

function recentlyOrdered(s: Store, m: MenuRec, companyId: string): ProductRec[] {
  const ids = new Set<string>();
  for (const o of s.orders.values()) if (o.company_id === companyId && o.status !== 'CANCELED') for (const i of o.items) ids.add(i.product_id);
  return menuProducts(s, m).filter((p) => ids.has(p.id));
}

// ── handlers ──────────────────────────────────────────────────────────────────────────────────

const ADMIN_PERMISSIONS = [
  'purchases_permissions_view',
  'purchases_permissions_create',
  'purchases_permissions_edit',
  'purchases_permissions_delete',
  'orders_permissions_view',
  'products_permissions_view',
  'inventory_permissions_adjust',
  'tasks_permissions_view',
  'tasks_permissions_create',
  'tasks_permissions_edit',
  'companies_permissions_view',
  'costs_permissions_view',
];

export const HANDLERS: { [N in DistruToolName]: Handler<N> } = {
  'distru-get-me': (a, { s, userId }) => {
    const u = s.users.get(userId)!;
    return {
      user: { id: mid('user', u.id), fullName: u.full_name, email: u.email, isAdmin: u.is_admin, ...(a.includePermissions ? { permissions: ADMIN_PERMISSIONS } : {}) },
      myCompany: { id: mid('company', s.selfCompanyId), name: s.selfCompanyName, legalBusinessName: SELF_COMPANY.legal_business_name },
      timezone: SELF_COMPANY.timezone,
      usState: SELF_COMPANY.us_state,
      complianceType: 'METRC',
      activeModules: ['API', 'CORE', 'COST_ACCOUNTING', 'METRC', 'QBO'],
      settings: { inventory: { allowNegativeAvailableQuantity: false, binTrackingEnabled: false }, sales: { salesOrderAutofulfill: false } },
    };
  },

  'distru-search-products': (a, { s, views }) => {
    const idList = ids('product', a.ids, 'ids');
    const cats = ids('category', a.productCategoryIds, 'productCategoryIds');
    const vendor = a.vendorId ? id('company', a.vendorId, 'vendorId') : undefined;
    const status = a.status ?? 'ACTIVE';
    const none = [a.brandIds, a.productGroupIds, a.productSubcategoryIds, a.tagIds].some((x) => x?.length) || a.hasBillOfMaterials === true || !!a.madeWithProductId || (a.unitTypeCategories && !a.unitTypeCategories.includes('COUNT'));
    const onMenus = ids('menu', a.menuIds, 'menuIds');
    const offMenus = ids('menu', a.notOnMenuIds, 'notOnMenuIds');
    const placed = (p: ProductRec, m: string) => isOnMenu({ ...p, is_active: true }, m);
    let list = [...s.products.values()].filter((p) => {
      if (none) return false;
      if (onMenus && !onMenus.some((m) => placed(p, m))) return false;
      if (offMenus && offMenus.some((m) => placed(p, m))) return false;
      if (status === 'ACTIVE' && !p.is_active) return false;
      if (status === 'INACTIVE' && p.is_active) return false;
      if (idList && !idList.includes(p.id)) return false;
      if (cats && !cats.includes(p.category_id)) return false;
      if (vendor && p.vendor_id !== vendor) return false;
      if (a.strainIds && (!p.strain || !a.strainIds.includes(p.strain.id))) return false;
      if (a.belowQuantityAvailableThresholdMin !== undefined) {
        const avail = s.quantityActive(p.id) - s.quantityReserved(p.id);
        const below = p.threshold_min != null && avail < p.threshold_min;
        if (below !== a.belowQuantityAvailableThresholdMin) return false;
      }
      if (!customMatch(s, {}, a.customFields)) return false;
      return true;
    });
    const avail = (p: ProductRec) => s.quantityActive(p.id) - s.quantityReserved(p.id);
    if (a.search) list = ranked(list, a.search, (p) => [p.name, p.sku]);
    else
      list = sorted(
        list,
        a.sortBy,
        {
          INSERTED_AT: (p) => p.inserted_datetime,
          NAME: (p) => p.name.toLowerCase(),
          QUANTITY_ACTIVE: (p) => s.quantityActive(p.id),
          QUANTITY_AVAILABLE: avail,
          QUANTITY_AVAILABLE_THRESHOLD_MIN_RATIO: (p) => (p.threshold_min ? avail(p) / p.threshold_min : null),
          UNIT_PRICE: (p) => p.unit_price,
          UPDATED_AT: (p) => p.updated_datetime,
        },
        { field: 'UPDATED_AT', direction: 'DESC' },
      );
    return paged(list, a, (p) => views.productRow(p));
  },

  'distru-get-product': (a, { s, views }) => {
    const p = s.products.get(id('product', a.id, 'id'));
    return {
      product: p
        ? views.productFull(p, { images: a.includeImages, tags: a.includeTags, byLocation: a.includeActiveQuantitiesByLocation, costItems: a.includeActiveQuantityCostItems, bom: a.includeBillOfMaterials })
        : null,
    };
  },

  'distru-report-inventory-valuation': (a, { s }) => {
    const locs = ids('location', a.locationIds, 'locationIds');
    const vendors = ids('company', a.vendorIds, 'vendorIds');
    const cats = ids('category', a.productCategoryIds, 'productCategoryIds');
    const byPrice = (a.calculationMethod ?? 'PRICE') === 'PRICE';
    const none = [a.userIds, a.productSubcategoryIds, a.productTagIds, a.brandIds, a.productGroupIds].some((x) => x?.length);
    let products = [...s.products.values()].filter((p) => p.is_active && !none && (!vendors || vendors.includes(p.vendor_id)) && (!cats || cats.includes(p.category_id)));
    if (a.search) {
      const q = a.search.toLowerCase();
      products = products.filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q));
    }
    products.sort((x, y) => x.name.localeCompare(y.name));
    const rows = products.map((p) => {
      const active = s.quantityActive(p.id, locs);
      const reserved = s.quantityReserved(p.id, locs);
      const vendor = s.companies.get(p.vendor_id);
      return {
        name: p.name,
        productId: mid('product', p.id),
        sku: p.sku,
        vendor: vendor?.name ?? '',
        vendorId: mid('company', p.vendor_id),
        unitType: 'Each',
        category: s.categories.get(p.category_id)?.name ?? '',
        subcategory: null,
        group: null,
        owner: null,
        activeQuantity: fmtNum(active),
        activeQuantityPassedTesting: null,
        assemblingQuantity: '0',
        reservedQuantity: fmtNum(reserved),
        availableQuantity: fmtNum(active - reserved),
        incomingQuantity: fmtNum(s.quantityIncoming(p.id, { locationIds: locs })),
        pendingOutputQuantity: '0',
        unitCost: money(p.unit_cost),
        unitPrice: money(p.unit_price),
        inventoryThresholdMax: p.threshold_max == null ? null : fmtNum(p.threshold_max),
        inventoryThresholdMin: p.threshold_min == null ? null : fmtNum(p.threshold_min),
        activeValue: money(active * (byPrice ? p.unit_price : p.unit_cost)),
        imageUrl: null,
        brand: null,
        brandId: null,
        customFields: [],
      };
    });
    const cols: [string, string][] = [
      ['name', 'Product'],
      ['sku', 'SKU'],
      ['vendor', 'Vendor'],
      ['category', 'Category'],
      ['activeQuantity', 'Active'],
      ['reservedQuantity', 'Reserved'],
      ['availableQuantity', 'Available'],
      ['incomingQuantity', 'Incoming'],
      ['unitCost', 'Unit cost'],
      ['unitPrice', 'Unit price'],
      ['activeValue', 'Active value'],
    ];
    return report('inventory_valuation', rows, a, cols, `As of ${new Date().toISOString()}`);
  },

  'distru-report-inventory-assets': (a, { s }) => {
    const loc = a.locationId ? id('location', a.locationId, 'locationId') : undefined;
    const vendors = ids('company', a.vendorIds, 'vendorIds');
    const cats = ids('category', a.productCategoryIds, 'productCategoryIds');
    const snap = requireOffset(a.snapshotDatetime, 'snapshotDatetime');
    if (snap && Date.parse(snap) < Date.parse('2023-08-03T11:00:00Z')) throw new ToolError('snapshotDatetime cannot be before 2023-08-03T11:00:00Z', [{ message: 'too early', path: ['snapshotDatetime'] }]);
    const none = [a.productSubcategoryIds, a.productTagIds, a.brandIds, a.productGroupIds].some((x) => x?.length);
    const lots = [...s.lots.values()]
      .filter((l) => {
        const p = s.products.get(l.product_id);
        if (!p || none || l.quantity <= 0) return false;
        if (loc && l.location_id !== loc) return false;
        if (vendors && !vendors.includes(p.vendor_id)) return false;
        if (cats && !cats.includes(p.category_id)) return false;
        return true;
      })
      .sort((x, y) => s.products.get(x.product_id)!.name.localeCompare(s.products.get(y.product_id)!.name) || x.location_id.localeCompare(y.location_id));
    const rows = lots.map((l) => {
      const p = s.products.get(l.product_id)!;
      const b = l.batch_id ? s.batches.get(l.batch_id) : undefined;
      const location = s.locations.get(l.location_id)!;
      const lic = s.licenses.get(location.license_id)!;
      const t = b ? [...s.testResults.values()].find((x) => x.batch_id === b.id) : undefined;
      const cost = b?.unit_cost ?? p.unit_cost;
      return {
        product: p.name,
        productId: mid('product', p.id),
        license: lic.license_number,
        licenseId: mid('license', lic.id),
        location: location.name,
        locationId: mid('location', location.id),
        packageNumber: l.compliance_label,
        packageId: l.compliance_label ? mid('package', l.id) : null,
        batchNumber: b?.batch_number ?? null,
        batchId: b ? mid('batch', b.id) : null,
        sku: p.sku,
        vendor: s.companies.get(p.vendor_id)?.name ?? '',
        vendorId: mid('company', p.vendor_id),
        owner: null,
        unitType: 'Each',
        activeQuantity: fmtNum(l.on_hold ? 0 : l.quantity),
        assemblingQuantity: '0',
        sellingQuantity: '0',
        category: s.categories.get(p.category_id)?.name ?? '',
        subcategory: null,
        unitPrice: money(p.unit_price),
        unitCostActual: money(cost),
        unitCostDefault: money(p.unit_cost),
        totalCostActual: money(cost * l.quantity),
        totalCostDefault: money(p.unit_cost * l.quantity),
        expirationDate: b?.expiration_datetime?.slice(0, 10) ?? null,
        trackingMethod: p.tracking,
        harvestDate: b?.harvest_datetime?.slice(0, 10) ?? null,
        labTestingState: b ? (t ? (t.passed ? 'PASSED' : 'FAILED') : 'NOT_TESTED') : null,
        customFields: [],
      };
    });
    const cols: [string, string][] = [
      ['product', 'Product'],
      ['location', 'Location'],
      ['packageNumber', 'Package'],
      ['batchNumber', 'Batch'],
      ['activeQuantity', 'Active'],
      ['unitCostActual', 'Unit cost'],
      ['totalCostActual', 'Total cost'],
      ['labTestingState', 'Lab testing'],
    ];
    return report('inventory_assets', rows, a, cols, `Snapshot ${snap ?? new Date().toISOString()}`);
  },

  'distru-search-purchase-orders': (a, ctx) => {
    const { s, views } = ctx;
    const idList = ids('purchaseOrder', a.ids, 'ids');
    const suppliers = ids('company', a.supplierIds, 'supplierIds');
    const productIds = ids('product', a.productIds, 'productIds');
    const batchIds = ids('batch', a.batchIds, 'batchIds');
    const owners = ids('user', a.ownerIds, 'ownerIds');
    const od = [dateBound(a.orderDateAfter, false, 'orderDateAfter'), dateBound(a.orderDateBefore, true, 'orderDateBefore')] as const;
    const dd = [dateBound(a.dueDateAfter, false, 'dueDateAfter'), dateBound(a.dueDateBefore, true, 'dueDateBefore')] as const;
    let list = [...s.purchases.values()].filter((p) => {
      if (a.status ? !a.status.includes(p.status) : p.status === 'DRAFT') return false;
      if (idList && !idList.includes(p.id)) return false;
      if (suppliers && (!p.company_id || !suppliers.includes(p.company_id))) return false;
      if (owners && (!p.owner_id || !owners.includes(p.owner_id))) return false;
      if (productIds && !p.items.some((i) => i.product_id && productIds.includes(i.product_id))) return false;
      if (batchIds && !p.items.some((i) => i.batch_id && batchIds.includes(i.batch_id))) return false;
      if (a.paymentStatus && !a.paymentStatus.includes(p.status === 'COMPLETED' ? 'PAID' : 'NOT_PAID')) return false;
      const total = purchaseTotal(ctx, p);
      if (a.totalGreaterThanOrEqualTo !== undefined && total < a.totalGreaterThanOrEqualTo) return false;
      if (a.totalLessThanOrEqualTo !== undefined && total > a.totalLessThanOrEqualTo) return false;
      if (!inRange(p.order_datetime, od[0], od[1])) return false;
      if (!inRange(p.due_datetime, dd[0], dd[1])) return false;
      if (!customMatch(s, p.custom_data, a.customFields)) return false;
      return true;
    });
    if (a.search) list = ranked(list, a.search, (p) => [p.purchase_number]);
    else
      list = sorted(
        list,
        a.sortBy,
        { DUE_DATE: (p) => p.due_datetime, INSERTED_AT: (p) => p.inserted_datetime, ORDER_DATE: (p) => p.order_datetime, PURCHASE_NUMBER: (p) => p.purchase_number, UPDATED_AT: (p) => p.updated_datetime },
        { field: 'UPDATED_AT', direction: 'DESC' },
      );
    return paged(list, a, (p) => views.purchaseOrderRow(p));
  },

  'distru-get-purchase-order': (a, { s, views }) => {
    const p = s.purchases.get(id('purchaseOrder', a.id, 'id'));
    return { purchaseOrder: p ? views.purchaseOrder(p, { items: a.includeOrderItems, charges: a.includeOrderCharges, payments: a.includePayments }) : null };
  },

  'distru-mutate-purchase-order': mutatePurchaseOrder,

  'distru-search-companies': (a, { s, views }) => {
    const idList = ids('company', a.ids, 'ids');
    const rel = a.relationshipTypeIds;
    const la = dateBound(a.lastOrderDateAfter, false, 'lastOrderDateAfter');
    const lb = dateBound(a.lastOrderDateBefore, true, 'lastOrderDateBefore');
    const none = !!a.groupIds?.length || a.hasBrokenQbCustomer === true || a.hasBrokenQbVendor === true;
    const all: ('self' | (typeof s.companies extends Map<string, infer C> ? C : never))[] = ['self', ...s.companies.values()];
    let list = all.filter((c) => {
      if (none) return false;
      const isSelf = c === 'self';
      const cid = isSelf ? s.selfCompanyId : c.id;
      if (a.isMyCompany !== undefined && a.isMyCompany !== isSelf) return false;
      if (idList && !idList.includes(cid)) return false;
      const v = views.company(c);
      if (a.categories && !a.categories.includes(String(v.category))) return false;
      if (rel && (!v.relationshipType || !rel.includes(v.relationshipType.id))) return false;
      const locIds = isSelf ? s.ownLocationIds : c.location_ids;
      const locs = locIds.map((x) => s.locations.get(x)!);
      if (a.city && !locs.some((l) => l.city.toLowerCase().includes(a.city!.toLowerCase()))) return false;
      if (a.zip && !locs.some((l) => l.zip.toLowerCase() === a.zip!.toLowerCase())) return false;
      if (a.licenseNumber && !locs.some((l) => s.licenses.get(l.license_id)?.license_number.toLowerCase().includes(a.licenseNumber!.toLowerCase()))) return false;
      if (a.hasOutstandingBalance !== undefined && Number(v.outstandingBalance) > 0 !== a.hasOutstandingBalance) return false;
      if ((la !== undefined || lb !== undefined) && !inRange(v.lastOrderDate, la, lb)) return false;
      if (!customMatch(s, {}, a.customFields)) return false;
      return true;
    });
    const nameOf = (c: (typeof list)[number]) => (c === 'self' ? s.selfCompanyName : c.name);
    if (a.search) list = ranked(list, a.search, (c) => (c === 'self' ? [s.selfCompanyName, SELF_COMPANY.legal_business_name] : [c.name, c.legal_business_name]));
    else
      list = sorted(
        list,
        a.sortBy,
        {
          INSERTED_AT: (c) => (c === 'self' ? '' : c.inserted_datetime),
          LAST_ORDER_DATE: (c) => views.company(c).lastOrderDate,
          NAME: (c) => nameOf(c).toLowerCase(),
          OUTSTANDING_BALANCE: (c) => Number(views.company(c).outstandingBalance),
          PAST_DUE_BALANCE: (c) => Number(views.company(c).pastDueBalance),
          UPDATED_AT: (c) => (c === 'self' ? '' : c.updated_datetime),
        },
        { field: 'UPDATED_AT', direction: 'DESC' },
      );
    return paged(list, a, (c) => views.company(c));
  },

  'distru-get-company': (a, { s, views }) => {
    const cid = id('company', a.id, 'id');
    const c = cid === s.selfCompanyId ? 'self' : s.companies.get(cid);
    return { company: c ? views.companyFull(c, { contacts: a.includeContacts, locations: a.includeLocations, licenses: a.includeLicenses }) : null };
  },

  'distru-search-packages': (a, { s, views }) => {
    const idList = ids('package', a.ids, 'ids');
    const licenses = ids('license', a.licenseIds, 'licenseIds');
    const locs = ids('location', a.locationIds, 'locationIds');
    const products = ids('product', a.productIds, 'productIds');
    const cats = ids('category', a.productCategoryIds, 'productCategoryIds');
    const vendors = ids('company', a.vendorIds, 'vendorIds');
    const status = a.status ?? (idList ? 'ANY' : 'ACTIVE');
    const none = status === 'INACTIVE' || a.isTestSample === true || a.syncing === true || [a.productSubcategoryIds, a.productTagIds, a.brandIds, a.productGroupIds].some((x) => x?.length);
    const thcMin = num(a.thcPercentageTotal?.min, ['thcPercentageTotal', 'min']);
    const thcMax = num(a.thcPercentageTotal?.max, ['thcPercentageTotal', 'max']);
    let list = [...s.lots.values()].filter((l): l is LotRec => {
      if (!l.compliance_label || none) return false;
      const p = s.products.get(l.product_id)!;
      const row = views.packageRow(l);
      if (idList && !idList.includes(l.id)) return false;
      if (licenses && !licenses.includes(s.locations.get(l.location_id)!.license_id)) return false;
      if (locs && !locs.includes(l.location_id)) return false;
      if (products && !products.includes(p.id)) return false;
      if (cats && !cats.includes(p.category_id)) return false;
      if (vendors && !vendors.includes(p.vendor_id)) return false;
      if (a.distruStatuses && !(a.distruStatuses as string[]).includes(row.distruStatus)) return false;
      if (a.withQuantity !== undefined && l.quantity > 0 !== a.withQuantity) return false;
      if (a.hasTestResult !== undefined && !!row.primaryTestResult !== a.hasTestResult) return false;
      if (a.labTestingStates && !a.labTestingStates.includes(row.labTestingState)) return false;
      if (a.isFinishedGood !== undefined && row.isFinishedGood !== a.isFinishedGood) return false;
      if (thcMin !== undefined || thcMax !== undefined) {
        const thc = row.primaryTestResult ? Number(row.primaryTestResult.thcPercentageTotal) : null;
        if (thc === null || (thcMin !== undefined && thc < thcMin) || (thcMax !== undefined && thc > thcMax)) return false;
      }
      if (!customMatch(s, {}, a.customFields)) return false;
      return true;
    });
    if (a.search) list = ranked(list, a.search, (l) => [l.compliance_label ?? '', s.products.get(l.product_id)!.name, s.products.get(l.product_id)!.sku]);
    else
      list = sorted(
        list,
        a.sortBy,
        {
          BATCH_NUMBER: (l) => (l.batch_id ? (s.batches.get(l.batch_id)?.batch_number ?? null) : null),
          COMPLIANCE_LABEL: (l) => l.compliance_label,
          EXPIRATION_DATE: (l) => (l.batch_id ? (s.batches.get(l.batch_id)?.expiration_datetime ?? null) : null),
          INSERTED_AT: (l) => l.inserted_datetime,
          QUANTITY: (l) => l.quantity,
          UPDATED_AT: (l) => l.updated_datetime,
        },
        { field: 'UPDATED_AT', direction: 'DESC' },
      );
    return paged(list, a, (l) => views.packageRow(l));
  },

  'distru-get-package': (a, { s, views }) => {
    const l = s.lots.get(id('package', a.id, 'id'));
    return { package: l?.compliance_label ? views.packageFull(l, { costItems: a.includeQuantityCostItems }) : null };
  },

  'distru-search-test-results': (a, { s, views }) => {
    const batches = ids('batch', a.batchIds, 'batchIds');
    const packages = ids('package', a.packageIds, 'packageIds');
    const products = ids('product', a.productIds, 'productIds');
    let list = [...s.testResults.values()].filter((t) => {
      if (batches && !batches.includes(t.batch_id)) return false;
      if (packages) {
        const lotBatches = packages.map((p) => s.lots.get(p)?.batch_id).filter(Boolean);
        if (!(t.package_id && packages.includes(t.package_id)) && !lotBatches.includes(t.batch_id)) return false;
      }
      if (products && !products.includes(s.batches.get(t.batch_id)?.product_id ?? '')) return false;
      return true;
    });
    list = sorted(list, a.sortBy, { INSERTED_AT: (t) => t.inserted_datetime, NAME: (t) => t.name.toLowerCase(), UPDATED_AT: (t) => t.updated_datetime }, { field: 'UPDATED_AT', direction: 'DESC' });
    return paged(list, a, (t) => views.testResultRow(t));
  },

  'distru-search-sales-orders': (a, { s, ser, views }) => {
    const idList = ids('salesOrder', a.ids, 'ids');
    const customers = ids('company', a.customerIds, 'customerIds');
    const products = ids('product', a.productIds, 'productIds');
    const batches = ids('batch', a.batchIds, 'batchIds');
    const od = [dateBound(a.orderDateAfter, false, 'orderDateAfter'), dateBound(a.orderDateBefore, true, 'orderDateBefore')] as const;
    const dd = [dateBound(a.dueDateAfter, false, 'dueDateAfter'), dateBound(a.dueDateBefore, true, 'dueDateBefore')] as const;
    const del = [dateBound(a.deliveryDateAfter, false, 'deliveryDateAfter'), dateBound(a.deliveryDateBefore, true, 'deliveryDateBefore')] as const;
    const none = !!a.ownerIds?.length || !!a.menuIds?.length || !!a.taxIds?.length;
    let list = [...s.orders.values()].filter((o) => {
      if (none) return false;
      if (idList && !idList.includes(o.id)) return false;
      if (a.status && !(a.status as string[]).includes(o.status)) return false;
      if (customers && !customers.includes(o.company_id)) return false;
      if (products && !o.items.some((i) => products.includes(i.product_id))) return false;
      if (batches && !o.items.some((i) => i.batch_id && batches.includes(i.batch_id))) return false;
      if (a.paymentStatus && !(a.paymentStatus as string[]).includes(orderPaymentStatus(o))) return false;
      const total = ser.orderTotal(o);
      if (a.totalGreaterThanOrEqualTo !== undefined && total < a.totalGreaterThanOrEqualTo) return false;
      if (a.totalLessThanOrEqualTo !== undefined && total > a.totalLessThanOrEqualTo) return false;
      if (!inRange(o.order_datetime, od[0], od[1]) || !inRange(o.due_datetime, dd[0], dd[1]) || !inRange(o.delivery_datetime, del[0], del[1])) return false;
      if (!customMatch(s, {}, a.customFields)) return false;
      return true;
    });
    if (a.search) list = ranked(list, a.search, (o) => [o.order_number, s.companies.get(o.company_id)?.name ?? '']);
    else
      list = sorted(
        list,
        a.sortBy,
        { DUE_DATE: (o) => o.due_datetime, INSERTED_AT: (o) => o.inserted_datetime, ORDER_DATE: (o) => o.order_datetime, ORDER_NUMBER: (o) => o.order_number, TOTAL: (o) => ser.orderTotal(o), UPDATED_AT: (o) => o.updated_datetime },
        { field: 'UPDATED_AT', direction: 'DESC' },
      );
    return paged(list, a, (o) => views.salesOrderRow(o));
  },

  'distru-get-sales-order': (a, { s, views }) => {
    const o = s.orders.get(id('salesOrder', a.id, 'id'));
    return {
      salesOrder: o
        ? views.salesOrder(o, { invoices: a.includeInvoices, items: a.includeOrderItems || a.includeOrderItemCostItems || a.includeOrderItemPriceTiers, charges: a.includeOrderCharges, originals: a.includeOriginalOrders })
        : null,
    };
  },

  'distru-adjust-inventory': (a, { ops, views }) => {
    const res = ops.adjustInventory(
      {
        packageId: a.packageId ? id('package', a.packageId, 'packageId') : undefined,
        batchId: a.batchId ? id('batch', a.batchId, 'batchId') : undefined,
        productId: a.productId ? id('product', a.productId, 'productId') : undefined,
        locationId: a.locationId ? id('location', a.locationId, 'locationId') : undefined,
        quantity: num(a.quantity, ['quantity'])!,
        reason: a.reason,
        complianceReason: a.complianceReason,
        description: a.description,
        adjustedDatetime: requireOffset(a.adjustedDatetime, 'adjustedDatetime'),
      },
      'MCP',
    );
    if (!res.ok) throw new ToolError(res.errors.map((e) => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message)).join('; '), res.errors);
    return { stockAdjustment: views.stockAdjustment(res.adjustment) };
  },

  'distru-mutate-task': mutateTask,

  'distru-search-tasks': (a, { s, views }) => {
    const idList = ids('task', a.ids, 'ids');
    const owners = ids('user', a.ownerIds, 'ownerIds');
    const due = [dateBound(a.dueDateAfter, false, 'dueDateAfter'), dateBound(a.dueDateBefore, true, 'dueDateBefore')] as const;
    const REL: Record<string, string> = { SALES_ORDER: 'order', PURCHASE_ORDER: 'purchase', PRODUCT: 'product', BATCH: 'batch', COMPANY: 'company', INVOICE: 'invoice', CONTACT: 'contact', ASSEMBLY: 'assembly', RETURN: 'return' };
    const linkFilters: [string, string[] | undefined][] = [
      ['purchase', ids('purchaseOrder', a.purchaseOrderIds, 'purchaseOrderIds')],
      ['order', ids('salesOrder', a.salesOrderIds, 'salesOrderIds')],
      ['product', ids('product', a.productIds, 'productIds')],
      ['batch', ids('batch', a.batchIds, 'batchIds')],
      ['company', ids('company', a.companyIds, 'companyIds')],
      ['invoice', ids('invoice', a.invoiceIds, 'invoiceIds')],
      ['assembly', ids('assembly', a.assemblyIds, 'assemblyIds')],
      ['contact', a.contactIds],
      ['return', a.returnIds],
    ];
    const activeLinks = linkFilters.filter(([, v]) => v?.length);
    if (activeLinks.length && a.relatedTypes?.length) throw new ToolError('relatedTypes cannot be combined with the record ID filters', [{ message: 'not combinable', path: ['relatedTypes'] }]);
    let list = [...s.tasks.values()].filter((t: TaskRec) => {
      if (idList && !idList.includes(t.id)) return false;
      if (a.statuses && !a.statuses.includes(t.status)) return false;
      if (owners && (!t.owner_id || !owners.includes(t.owner_id))) return false;
      if (!inRange(t.due_datetime, due[0], due[1])) return false;
      if (a.relatedTypes && (!t.link || !a.relatedTypes.some((r) => REL[r] === t.link!.kind))) return false;
      if (activeLinks.length && !activeLinks.some(([kind, v]) => t.link?.kind === kind && v!.includes(t.link.id))) return false;
      if (!customMatch(s, t.custom_data, a.customFields)) return false;
      return true;
    });
    if (a.search) list = ranked(list, a.search, (t) => [t.name]);
    else list = sorted(list, a.sortBy, { DUE_DATE: (t) => t.due_datetime, INSERTED_AT: (t) => t.inserted_datetime, NAME: (t) => t.name.toLowerCase(), UPDATED_AT: (t) => t.updated_datetime }, { field: 'UPDATED_AT', direction: 'DESC' });
    return paged(list, a, (t) => views.task(t));
  },

  'distru-search-users': (a, { s, views }) => {
    const idList = ids('user', a.ids, 'ids');
    let list = [...s.users.values()].filter((u) => !u.banned && (!idList || idList.includes(u.id)));
    if (a.search) list = ranked(list, a.search, (u) => [u.full_name]);
    else list = sorted(list, a.sortBy, { FULL_NAME: (u) => u.full_name.toLowerCase(), INSERTED_AT: (u) => u.inserted_datetime, UPDATED_AT: (u) => u.updated_datetime }, { field: 'UPDATED_AT', direction: 'DESC' });
    return paged(list, a, (u) => views.user(u));
  },

  'distru-get-record-history': (a, { s, views }) => {
    const KIND: Record<string, IdKind> = { PURCHASE: 'purchaseOrder', SALES_ORDER: 'salesOrder', PRODUCT: 'product', BATCH: 'batch', PACKAGE: 'package', COMPANY: 'company', USER: 'user', TEST_RESULT: 'testResult', INVOICE: 'invoice', ASSEMBLY: 'assembly', MENU: 'menu' };
    const type = a.recordType ?? 'PURCHASE';
    const kind = KIND[type];
    const rid = kind ? id(kind, a.recordId, 'recordId') : a.recordId;
    let entries = [...s.activity].filter((e) => e.records.some((r) => r.type === type && r.id === rid));
    const asc = a.sortBy?.direction === 'ASC';
    entries = asc ? entries : entries.reverse();
    return paged(entries, a, (e) => views.historyChange(e, type, rid));
  },

  'distru-search-activity': (a, { s, views }) => {
    const idList = a.ids?.map((x, i) => fromMcpId('activity', x, ['ids', i]));
    const users = ids('user', a.userIds, 'userIds');
    const start = dateBound(a.changedAt?.start, false, 'changedAt.start');
    const end = dateBound(a.changedAt?.end, true, 'changedAt.end');
    const defaultFrom = Date.now() - 7 * 86_400_000;
    let list = [...s.activity].filter((e) => {
      if (idList) return idList.includes(e.id);
      if (start !== undefined || end !== undefined) {
        if (!inRange(e.changed_datetime, start, end)) return false;
      } else if (Date.parse(e.changed_datetime) < defaultFrom) return false;
      if (users && (!e.actor_id || !users.includes(e.actor_id))) return false;
      if (a.sources && !(a.sources as string[]).includes(e.source)) return false;
      if (a.ops && !e.records.some((r) => a.ops!.includes(r.op))) return false;
      if (a.recordTypes && !e.records.some((r) => r.type && (a.recordTypes as string[]).includes(r.type))) return false;
      return true;
    });
    if (a.sortBy?.direction !== 'ASC') list = list.reverse();
    return paged(list, a, (e) => views.activity(e, a.recordTypes as string[] | undefined));
  },

  'distru-email-pdf': emailPdf,
  ...MENU_HANDLERS,
};

/** Write tools that generate PDFs (count against the PDF limits). */
export const PDF_TOOLS = new Set<string>(['distru-email-pdf']);

export function toolCtx(s: Store, ser: Serializer, ops: Ops, userId: string): ToolCtx {
  return { s, ser, ops, views: new McpViews(s, ser), userId };
}

export { IdError };
