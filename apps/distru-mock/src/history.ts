/**
 * Activity + record history. Every write (REST or MCP) records one operation with the rows it changed,
 * field by field, like Distru's History tab. GET /public/v1/activity, GET /public/v1/record-history
 * and the MCP tools distru-search-activity / distru-get-record-history read from the same list.
 */
import type { Store } from './store';
import type { ActivityRec, ActivitySource, HistoryFieldChange, HistoryRow, OrderRec, PurchaseItemRec, PurchaseRec, TaskRec } from './types';

type Plain = Record<string, unknown>;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Field changes between two flat views (`null` view = row added/removed: list the fields it had set). */
export function diffFields(before: Plain | null, after: Plain | null, labels: Record<string, string>): HistoryFieldChange[] {
  const out: HistoryFieldChange[] = [];
  for (const field of Object.keys(labels)) {
    const o = before ? (before[field] ?? null) : null;
    const n = after ? (after[field] ?? null) : null;
    if (same(o, n)) continue;
    out.push({ field, label: labels[field]!, old_value: o, new_value: n });
  }
  return out;
}

const ref = (id: string | null, name: string | null | undefined) => (id ? { id, name: name ?? null } : null);

const PURCHASE_LABELS: Record<string, string> = {
  status: 'Status',
  company: 'Supplier',
  location: 'Location',
  billing_location: 'Billing location',
  supplier_location: 'Supplier location',
  order_datetime: 'Order date',
  due_datetime: 'Due date',
  description: 'Description',
  owner: 'Owner',
  metrc_transfer_id: 'Metrc transfer',
};
const PURCHASE_ITEM_LABELS: Record<string, string> = {
  product: 'Product',
  batch: 'Batch',
  location: 'Location',
  quantity: 'Quantity',
  price: 'Price',
  received_quantity: 'Received quantity',
};
const CHARGE_LABELS: Record<string, string> = { name: 'Name', type: 'Type', unit_type: 'Unit type', price: 'Price', percent: 'Percent' };

function purchaseView(s: Store, p: PurchaseRec): Plain {
  const v: Plain = {
    status: p.status,
    company: ref(p.company_id, p.company_id ? s.companies.get(p.company_id)?.name : null),
    location: ref(p.location_id, p.location_id ? s.locations.get(p.location_id)?.name : null),
    billing_location: ref(p.billing_location_id, p.billing_location_id ? s.locations.get(p.billing_location_id)?.name : null),
    supplier_location: ref(p.supplier_location_id, p.supplier_location_id ? s.locations.get(p.supplier_location_id)?.name : null),
    order_datetime: p.order_datetime,
    due_datetime: p.due_datetime,
    description: p.description,
    owner: ref(p.owner_id, p.owner_id ? s.users.get(p.owner_id)?.full_name : null),
    metrc_transfer_id: p.metrc_transfer_id,
  };
  for (const [k, val] of Object.entries(p.custom_data)) v[`custom_data.${k}`] = val;
  return v;
}

function itemView(s: Store, i: PurchaseItemRec): Plain {
  return {
    product: ref(i.product_id, i.product_id ? s.products.get(i.product_id)?.name : null),
    batch: ref(i.batch_id, i.batch_id ? s.batches.get(i.batch_id)?.batch_number : null),
    location: ref(i.location_id, i.location_id ? s.locations.get(i.location_id)?.name : null),
    quantity: String(i.quantity),
    price: i.price.toFixed(2),
    received_quantity: String(i.received_quantity),
  };
}

function itemLabel(s: Store, i: PurchaseItemRec): string {
  const name = (i.product_id && s.products.get(i.product_id)?.name) || (i.batch_id && s.batches.get(i.batch_id)?.batch_number) || 'Line';
  return `${name}: ${i.quantity} @ $${i.price.toFixed(2)}`;
}

function rowsFor<T extends { id: string }>(
  before: T[],
  after: T[],
  entity: string,
  entityLabel: string,
  view: (t: T) => Plain,
  labels: Record<string, string>,
  label: (t: T) => string | null,
): HistoryRow[] {
  const rows: HistoryRow[] = [];
  const prev = new Map(before.map((x) => [x.id, x]));
  const next = new Map(after.map((x) => [x.id, x]));
  for (const a of after) {
    const b = prev.get(a.id);
    const fields = diffFields(b ? view(b) : null, view(a), labels);
    if (!b) rows.push({ entity, entity_label: entityLabel, op: 'INSERT', row_id: a.id, row_label: label(a), fields });
    else if (fields.length) rows.push({ entity, entity_label: entityLabel, op: 'UPDATE', row_id: a.id, row_label: label(a), fields });
  }
  for (const b of before) {
    if (!next.has(b.id)) rows.push({ entity, entity_label: entityLabel, op: 'DELETE', row_id: b.id, row_label: label(b), fields: diffFields(view(b), null, labels) });
  }
  return rows;
}

/** Rows a purchase write changed (header, items, charges). */
export function purchaseRows(s: Store, before: PurchaseRec | null, after: PurchaseRec | null): HistoryRow[] {
  const rows: HistoryRow[] = [];
  const labels = { ...PURCHASE_LABELS };
  for (const p of [before, after]) for (const k of Object.keys(p?.custom_data ?? {})) labels[`custom_data.${k}`] = s.customFields.get(Number(k))?.name ?? `Custom field ${k}`;
  const head = diffFields(before ? purchaseView(s, before) : null, after ? purchaseView(s, after) : null, labels);
  const op = !before ? 'INSERT' : !after ? 'DELETE' : 'UPDATE';
  const rec = (after ?? before)!;
  if (head.length || op !== 'UPDATE') rows.push({ entity: 'PURCHASE', entity_label: 'Purchase order', op, row_id: rec.id, row_label: null, fields: head });
  rows.push(...rowsFor(before?.items ?? [], after?.items ?? [], 'PURCHASE_ITEM', 'Purchase order item', (i) => itemView(s, i), PURCHASE_ITEM_LABELS, (i) => itemLabel(s, i)));
  rows.push(
    ...rowsFor(
      before?.charges ?? [],
      after?.charges ?? [],
      'PURCHASE_CHARGE',
      'Purchase order charge',
      (c) => ({ name: c.name, type: c.type, unit_type: c.unit_type, price: c.price, percent: c.percent }),
      CHARGE_LABELS,
      (c) => c.name,
    ),
  );
  return rows;
}

const ORDER_LABELS: Record<string, string> = {
  status: 'Status',
  company: 'Customer',
  location: 'Location',
  order_datetime: 'Order date',
  due_datetime: 'Due date',
  delivery_datetime: 'Delivery date',
  internal_notes: 'Internal notes',
  external_notes: 'External notes',
};
const ORDER_ITEM_LABELS: Record<string, string> = { product: 'Product', location: 'Location', quantity: 'Quantity', price: 'Price' };

/** Rows a sales order write changed (header + items). */
export function orderRows(s: Store, before: OrderRec | null, after: OrderRec | null): HistoryRow[] {
  const view = (o: OrderRec): Plain => ({
    status: o.status,
    company: ref(o.company_id, s.companies.get(o.company_id)?.name),
    location: ref(o.location_id, s.locations.get(o.location_id)?.name),
    order_datetime: o.order_datetime,
    due_datetime: o.due_datetime,
    delivery_datetime: o.delivery_datetime,
    internal_notes: o.internal_notes,
    external_notes: o.external_notes,
  });
  const rec = (after ?? before)!;
  const op = !before ? 'INSERT' : !after ? 'DELETE' : 'UPDATE';
  const rows: HistoryRow[] = [];
  const head = diffFields(before ? view(before) : null, after ? view(after) : null, ORDER_LABELS);
  if (head.length || op !== 'UPDATE') rows.push({ entity: 'SALES_ORDER', entity_label: 'Sales order', op, row_id: rec.id, row_label: null, fields: head });
  rows.push(
    ...rowsFor(
      before?.items ?? [],
      after?.items ?? [],
      'ORDER_ITEM',
      'Sales order item',
      (i) => ({ product: ref(i.product_id, s.products.get(i.product_id)?.name), location: ref(i.location_id, s.locations.get(i.location_id)?.name), quantity: String(i.quantity), price: i.price.toFixed(2) }),
      ORDER_ITEM_LABELS,
      (i) => `${s.products.get(i.product_id)?.name ?? 'Line'}: ${i.quantity} @ $${i.price.toFixed(2)}`,
    ),
  );
  return rows;
}

const TASK_LABELS: Record<string, string> = {
  name: 'Name',
  description: 'Description',
  status: 'Status',
  due_datetime: 'Due date',
  color: 'Color',
  owner: 'Assignee',
  location: 'Location',
  link: 'Linked record',
};

export function taskRows(s: Store, before: TaskRec | null, after: TaskRec | null): HistoryRow[] {
  const view = (t: TaskRec): Plain => ({
    name: t.name,
    description: t.description,
    status: t.status,
    due_datetime: t.due_datetime,
    color: t.color,
    owner: ref(t.owner_id, t.owner_id ? s.users.get(t.owner_id)?.full_name : null),
    location: ref(t.location_id, t.location_id ? s.locations.get(t.location_id)?.name : null),
    link: t.link ? { type: t.link.kind.toUpperCase(), id: t.link.id } : null,
  });
  const fields = diffFields(before ? view(before) : null, after ? view(after) : null, TASK_LABELS);
  const rec = (after ?? before)!;
  const op = !before ? 'INSERT' : !after ? 'DELETE' : 'UPDATE';
  if (!fields.length && op === 'UPDATE') return [];
  return [{ entity: 'TASK', entity_label: 'Task', op, row_id: rec.id, row_label: rec.name, fields }];
}

/** REST record-history type of a task's linked record (task rows show in that record's history). */
export function taskRecordType(t: TaskRec): string | null {
  switch (t.link?.kind) {
    case 'purchase':
      return 'PURCHASE';
    case 'order':
      return 'SALES_ORDER';
    case 'product':
      return 'PRODUCT';
    case 'batch':
      return 'BATCH';
    case 'company':
      return 'COMPANY';
    case 'invoice':
      return 'INVOICE';
    case 'assembly':
      return 'ASSEMBLY';
    case 'return':
      return 'RETURN';
    default:
      return null;
  }
}

export interface ActivityInput {
  source: ActivitySource;
  sourceDetail?: string | null;
  actorId?: string | null;
  records: ActivityRec['records'];
}

/** Records one operation; operations with no changed rows are dropped. Returns the entry (or null). */
export function recordActivity(s: Store, input: ActivityInput): ActivityRec | null {
  const records = input.records.filter((r) => r.rows.length);
  if (!records.length) return null;
  const entry: ActivityRec = {
    id: s.newId(),
    changed_datetime: s.nowIso(),
    actor_id: input.actorId === undefined ? s.apiUserId || null : input.actorId,
    source: input.source,
    source_detail: input.sourceDetail ?? (input.source === 'MCP' ? 'Distru MCP (mock)' : input.source === 'PUBLIC_API' ? 'API key: mock-token' : null),
    records,
  };
  s.activity.push(entry);
  if (s.activity.length > 5000) s.activity.splice(0, s.activity.length - 5000);
  return entry;
}

const MAX_ROWS = 50;

/** Actor as REST shows it. */
export function actorOf(s: Store, id: string | null) {
  if (!id) return null;
  const u = s.users.get(id);
  return { id, name: u?.full_name ?? 'Unknown user', company_name: s.selfCompanyName };
}

/** REST `ActivityEntry` (GET /public/v1/activity). */
export function serializeActivity(s: Store, a: ActivityRec, recordTypes?: string[]) {
  const records = a.records.filter((r) => !recordTypes || (r.type !== null && recordTypes.includes(r.type)));
  const counts = new Map<string, number>();
  for (const r of records) if (r.type) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
  let budget = MAX_ROWS;
  const rowCount = records.reduce((n, r) => n + r.rows.length, 0);
  return {
    id: a.id,
    changed_datetime: a.changed_datetime,
    actor: actorOf(s, a.actor_id),
    impersonator: null,
    source: a.source,
    source_detail: a.source_detail,
    row_count: rowCount,
    truncated: rowCount > MAX_ROWS,
    record_counts: [...counts].map(([type, count]) => ({ type, count })),
    records: records.map((r) => {
      const rows = r.rows.slice(0, Math.max(0, budget));
      budget -= rows.length;
      return { type: r.type, id: r.id, name: r.name, row_count: r.rows.length, truncated: rows.length < r.rows.length, rows, events: [] };
    }),
  };
}

/** REST `RecordHistoryEntry` list for one record, newest first. */
export function recordHistory(s: Store, recordType: string, recordId: string) {
  const out = [];
  for (let i = s.activity.length - 1; i >= 0; i--) {
    const a = s.activity[i]!;
    const rows = a.records.filter((r) => r.type === recordType && r.id === recordId).flatMap((r) => r.rows);
    if (!rows.length) continue;
    out.push({
      type: 'CHANGE' as const,
      id: a.id,
      changed_datetime: a.changed_datetime,
      actor: actorOf(s, a.actor_id),
      impersonator: null,
      source: a.source,
      source_detail: a.source_detail,
      rows,
      events: [],
    });
  }
  return out;
}
