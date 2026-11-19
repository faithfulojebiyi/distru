/**
 * Every write, whether it arrives over REST (`PUBLIC_API`) or MCP (`MCP`), goes through here so both
 * surfaces share one set of side effects:
 *
 * - activity / record history entries (source PUBLIC_API or MCP);
 * - webhooks: PURCHASE / ORDER for the record itself, PRODUCT when a product's company-wide active or
 *   reserved quantity changed (changes carry quantity_active / quantity_reserved / quantity_available),
 *   PACKAGE when a package (a tagged lot) was created or its quantity / status changed.
 * - INVOICE UPDATE when a payment is recorded against an invoice (changes: paid_amount, remaining_amount, status).
 */
import { recordInvoicePayment, type PaymentWrite } from './receivables';
import { diffFields, orderRows, purchaseRows, recordActivity, taskRecordType, taskRows } from './history';
import {
  adjustInventory as adjustInventoryRec,
  createCustomField as createCustomFieldRec,
  deletePurchase as deletePurchaseRec,
  deleteTask as deleteTaskRec,
  upsertTask as upsertTaskRec,
  type AdjustInput,
  type AdjustResult,
  type WriteResult,
} from './records';
import type { Serializer } from './serialize';
import type { Store } from './store';
import type { ActivitySource, CustomFieldDefRec, HistoryRow, MenuRec, OrderRec, ProductRec, PurchaseRec, TaskRec } from './types';
import { upsertOrder as upsertOrderRec, upsertPurchase as upsertPurchaseRec, type UpsertResult } from './upsert';
import { fmtNum } from './util';
import { computeChanges, type WebhookDispatcher } from './webhooks';

interface StockSnapshot {
  products: Map<string, { active: number; reserved: number }>;
  packages: Map<string, { quantity: number; status: string }>;
}

export interface OpsContext {
  store: () => Store;
  ser: () => Serializer;
  webhooks: WebhookDispatcher;
  /** test toggle: the next N Metrc-bound writes fail in Metrc after Distru saved them */
  metrc: { fail_next: number };
}

export class Ops {
  constructor(private readonly ctx: OpsContext) {}

  private get s() {
    return this.ctx.store();
  }
  private get ser() {
    return this.ctx.ser();
  }

  private snapshot(): StockSnapshot {
    const s = this.s;
    const products = new Map<string, { active: number; reserved: number }>();
    for (const p of s.products.values()) products.set(p.id, { active: s.quantityActive(p.id), reserved: s.quantityReserved(p.id) });
    const packages = new Map<string, { quantity: number; status: string }>();
    for (const l of s.lots.values()) if (l.compliance_label) packages.set(l.id, { quantity: l.quantity, status: this.ser.package(l).distru_status });
    return { products, packages };
  }

  /** PRODUCT + PACKAGE webhooks for whatever stock moved since `before`. */
  private emitStock(before: StockSnapshot): void {
    const after = this.snapshot();
    for (const [id, a] of after.products) {
      const b = before.products.get(id);
      if (!b || (b.active === a.active && b.reserved === a.reserved)) continue;
      const changes: Record<string, unknown> = {};
      if (b.active !== a.active) changes.quantity_active = { before: fmtNum(b.active), after: fmtNum(a.active) };
      if (b.reserved !== a.reserved) changes.quantity_reserved = { before: fmtNum(b.reserved), after: fmtNum(a.reserved) };
      changes.quantity_available = { before: fmtNum(b.active - b.reserved), after: fmtNum(a.active - a.reserved) };
      this.ctx.webhooks.emit('PRODUCT', 'UPDATE', id, changes);
    }
    for (const [id, a] of after.packages) {
      const b = before.packages.get(id);
      if (!b) this.ctx.webhooks.emit('PACKAGE', 'CREATE', id);
      else if (b.quantity !== a.quantity || b.status !== a.status) {
        const changes: Record<string, unknown> = {};
        if (b.quantity !== a.quantity) changes.quantity_active = { before: fmtNum(b.quantity), after: fmtNum(a.quantity) };
        if (b.status !== a.status) changes.distru_status = { before: b.status, after: a.status };
        this.ctx.webhooks.emit('PACKAGE', 'UPDATE', id, changes);
      }
    }
  }

  upsertPurchase(body: unknown, source: ActivitySource): UpsertResult<PurchaseRec> {
    const snap = this.snapshot();
    const beforeApi = this.peekPurchase(body);
    const res = upsertPurchaseRec(this.s, body);
    if (!res.ok) return res;
    const after = this.ser.purchase(res.record);
    recordActivity(this.s, { source, records: [{ type: 'PURCHASE', id: res.record.id, name: res.record.purchase_number, op: res.created ? 'INSERT' : 'UPDATE', rows: purchaseRows(this.s, res.before, res.record) }] });
    this.ctx.webhooks.emit('PURCHASE', res.created ? 'CREATE' : 'UPDATE', res.record.id, computeChanges(beforeApi, after));
    this.emitStock(snap);
    return res;
  }

  /** API shape of the purchase an upsert body targets, before the write (for webhook `changes`). */
  private peekPurchase(body: unknown) {
    const id = typeof body === 'object' && body !== null && 'id' in body ? (body as { id?: unknown }).id : undefined;
    const rec = typeof id === 'string' ? this.s.purchases.get(id) : undefined;
    return rec ? this.ser.purchase(rec) : null;
  }

  deletePurchase(id: string, source: ActivitySource): WriteResult<PurchaseRec> {
    const snap = this.snapshot();
    const linkedTasks = [...this.s.tasks.values()].filter((t) => t.link?.kind === 'purchase' && t.link.id === id);
    const res = deletePurchaseRec(this.s, id);
    if (!res.ok) return res;
    const rows: HistoryRow[] = [...purchaseRows(this.s, res.record, null), ...linkedTasks.flatMap((t) => taskRows(this.s, t, null))];
    recordActivity(this.s, { source, records: [{ type: 'PURCHASE', id, name: res.record.purchase_number, op: 'DELETE', rows }] });
    this.ctx.webhooks.emit('PURCHASE', 'DELETE', id);
    this.emitStock(snap);
    return res;
  }

  upsertOrder(body: unknown, source: ActivitySource): UpsertResult<OrderRec> {
    const snap = this.snapshot();
    const id = typeof body === 'object' && body !== null && 'id' in body ? (body as { id?: unknown }).id : undefined;
    const prev = typeof id === 'string' ? this.s.orders.get(id) : undefined;
    const beforeApi = prev ? this.ser.order(prev) : null;
    const res = upsertOrderRec(this.s, body);
    if (!res.ok) return res;
    const after = this.ser.order(res.record);
    recordActivity(this.s, { source, records: [{ type: 'SALES_ORDER', id: res.record.id, name: res.record.order_number, op: res.created ? 'INSERT' : 'UPDATE', rows: orderRows(this.s, res.before, res.record) }] });
    this.ctx.webhooks.emit('ORDER', res.created ? 'CREATE' : 'UPDATE', res.record.id, computeChanges(beforeApi, after));
    this.emitStock(snap);
    return res;
  }

  /** POST /invoices/{id}/payments: the payment, an activity entry and an INVOICE UPDATE webhook. */
  recordInvoicePayment(invoiceId: string, body: unknown, source: ActivitySource): PaymentWrite {
    const prev = this.s.invoices.get(invoiceId);
    const beforeApi = prev ? this.ser.invoice(prev) : null;
    const res = recordInvoicePayment(this.s, invoiceId, body);
    if (!res.ok) return res;
    const after = this.ser.invoice(res.invoice);
    recordActivity(this.s, {
      source,
      records: [
        {
          type: 'INVOICE',
          id: res.invoice.id,
          name: res.invoice.invoice_number,
          op: 'UPDATE',
          rows: [
            {
              entity: 'payment',
              entity_label: 'Payment',
              op: 'INSERT',
              row_id: res.payment.id,
              row_label: res.payment.payment_number,
              fields: [
                { field: 'amount', label: 'Amount', old_value: null, new_value: fmtNum(res.payment.amount, 2) },
                { field: 'payment_datetime', label: 'Payment date', old_value: null, new_value: res.payment.payment_datetime },
              ],
            },
          ],
        },
      ],
    });
    const changes: Record<string, unknown> = {};
    for (const k of ['paid_amount', 'remaining_amount', 'status'] as const) if (beforeApi && beforeApi[k] !== after[k]) changes[k] = { before: beforeApi[k], after: after[k] };
    this.ctx.webhooks.emit('INVOICE', 'UPDATE', res.invoice.id, changes);
    return res;
  }

  upsertTask(body: unknown, source: ActivitySource): WriteResult<TaskRec> {
    const res = upsertTaskRec(this.s, body, this.s.apiUserId || null);
    if (!res.ok) return res;
    this.recordTask(res.before, res.record, source);
    return res;
  }

  deleteTask(id: string, source: ActivitySource): WriteResult<TaskRec> {
    const res = deleteTaskRec(this.s, id);
    if (!res.ok) return res;
    this.recordTask(res.record, null, source);
    return res;
  }

  private recordTask(before: TaskRec | null, after: TaskRec | null, source: ActivitySource): void {
    const t = (after ?? before)!;
    const type = taskRecordType(t);
    const recordName = (() => {
      if (!t.link) return t.name;
      if (t.link.kind === 'purchase') return this.s.purchases.get(t.link.id)?.purchase_number ?? null;
      if (t.link.kind === 'order') return this.s.orders.get(t.link.id)?.order_number ?? null;
      if (t.link.kind === 'product') return this.s.products.get(t.link.id)?.name ?? null;
      if (t.link.kind === 'company') return this.s.companies.get(t.link.id)?.name ?? null;
      if (t.link.kind === 'batch') return this.s.batches.get(t.link.id)?.batch_number ?? null;
      return null;
    })();
    recordActivity(this.s, { source, records: [{ type, id: t.link?.id ?? t.id, name: recordName, op: !before ? 'INSERT' : !after ? 'DELETE' : 'UPDATE', rows: taskRows(this.s, before, after) }] });
  }

  adjustInventory(input: AdjustInput, source: ActivitySource): AdjustResult {
    const snap = this.snapshot();
    const metrc = this.ctx.metrc;
    const willReachMetrc = !!input.packageId && !!this.s.lots.get(input.packageId)?.metrc_id;
    const res = adjustInventoryRec(this.s, input, { metrcFails: willReachMetrc && metrc.fail_next > 0, source });
    if (!res.ok) return res;
    if (res.adjustment.compliance_activity && metrc.fail_next > 0) metrc.fail_next--;
    const a = res.adjustment;
    const product = this.s.products.get(a.product_id);
    const type = a.package_id ? 'PACKAGE' : a.batch_id ? 'BATCH' : 'PRODUCT';
    const id = a.package_id ?? a.batch_id ?? a.product_id;
    const name = a.package_id ? (this.s.lots.get(a.package_id)?.compliance_label ?? null) : a.batch_id ? (this.s.batches.get(a.batch_id)?.batch_number ?? null) : (product?.name ?? null);
    const rows: HistoryRow[] = [
      {
        entity: 'STOCK_ADJUSTMENT',
        entity_label: 'Adjustment',
        op: 'INSERT',
        row_id: a.id,
        row_label: `${a.quantity > 0 ? '+' : ''}${a.quantity} ${product?.name ?? ''}`.trim(),
        fields: [
          { field: 'quantity', label: 'Quantity', old_value: null, new_value: fmtNum(a.quantity) },
          ...(a.reason ? [{ field: 'reason', label: 'Reason', old_value: null, new_value: a.reason }] : []),
          ...(a.description ? [{ field: 'description', label: 'Description', old_value: null, new_value: a.description }] : []),
        ],
      },
    ];
    for (const lot of res.lots) {
      const b = snap.packages.get(lot.id);
      if (lot.compliance_label && b) rows.push({ entity: 'PACKAGE', entity_label: 'Package', op: 'UPDATE', row_id: lot.id, row_label: lot.compliance_label, fields: [{ field: 'quantity', label: 'Quantity', old_value: fmtNum(b.quantity), new_value: fmtNum(lot.quantity) }] });
    }
    recordActivity(this.s, { source, records: [{ type, id, name, op: 'UPDATE', rows }] });
    this.emitStock(snap);
    return res;
  }

  createCustomField(body: unknown, source: ActivitySource): WriteResult<CustomFieldDefRec> {
    const res = createCustomFieldRec(this.s, body);
    if (!res.ok) return res;
    const d = res.record;
    recordActivity(this.s, {
      source,
      records: [
        {
          type: null,
          id: String(d.id),
          name: d.name,
          op: 'INSERT',
          rows: [{ entity: 'CUSTOM_FIELD', entity_label: 'Custom field', op: 'INSERT', row_id: String(d.id), row_label: d.name, fields: [{ field: 'name', label: 'Name', old_value: null, new_value: d.name }] }],
        },
      ],
    });
    return res;
  }

  /** Saves a menu (create or update) and records it (record type MENU). */
  saveMenu(before: MenuRec | null, after: MenuRec, source: ActivitySource): MenuRec {
    after.updated_datetime = this.s.nowIso();
    this.s.menus.set(after.id, after);
    const view = (m: MenuRec): Record<string, unknown> => {
      const v: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(m)) {
        if (k === 'collections') v.collections = m.collections.map((c) => c.name);
        else if (k === 'passcode') v.passcode = m.passcode ? '••••' : null;
        else if (!['id', 'inserted_datetime', 'updated_datetime'].includes(k)) v[k] = val;
      }
      return v;
    };
    const labels = Object.fromEntries(Object.keys(view(after)).map((k) => [k, k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())]));
    const fields = diffFields(before ? view(before) : null, view(after), labels);
    recordActivity(this.s, { source, records: [{ type: 'MENU', id: after.id, name: after.name, op: before ? 'UPDATE' : 'INSERT', rows: fields.length || !before ? [{ entity: 'MENU', entity_label: 'Menu', op: before ? 'UPDATE' : 'INSERT', row_id: after.id, row_label: null, fields }] : [] }] });
    return after;
  }

  /** Saves (or, with `after` null, deletes) a catalog product; records history and a PRODUCT webhook. */
  saveProduct(before: ProductRec | null, after: ProductRec | null, source: ActivitySource): void {
    const s = this.s;
    const beforeApi = before ? this.ser.product(before) : null;
    if (after) {
      after.updated_datetime = s.nowIso();
      s.products.set(after.id, after);
    } else if (before) {
      s.products.delete(before.id);
      s.deletedRecords.push({ record_type: 'PRODUCT', record_id: before.id, deleted_datetime: s.nowIso() });
    }
    const view = (p: ProductRec): Record<string, unknown> => ({
      name: p.name,
      sku: p.sku,
      description: p.description,
      external_name: p.external_name ?? null,
      category: { id: p.category_id, name: s.categories.get(p.category_id)?.name ?? null },
      vendor: { id: p.vendor_id, name: s.companies.get(p.vendor_id)?.name ?? null },
      unit_price: p.unit_price.toFixed(2),
      unit_cost: p.unit_cost.toFixed(2),
      msrp: p.msrp.toFixed(2),
      units_per_case: p.units_per_case,
      quantity_available_threshold_min: p.threshold_min,
      quantity_available_threshold_max: p.threshold_max,
      max_menu_buyer_order_quantity: p.max_menu_buyer_order_quantity ?? null,
      menu_visibility: p.menu_visibility ?? 'INCLUDE_IN_ALL',
      menus: (p.menu_ids ?? []).map((id) => ({ id, name: s.menus.get(id)?.name ?? null })),
      is_active: p.is_active,
      is_featured: p.is_featured ?? false,
      total_thc: p.total_thc,
      total_cbd: p.total_cbd,
      total_cannabinoid_unit: p.cannabinoid_unit,
    });
    const rec = (after ?? before)!;
    const labels = Object.fromEntries(Object.keys(view(rec)).map((k) => [k, k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())]));
    const op = !before ? 'INSERT' : !after ? 'DELETE' : 'UPDATE';
    const fields = diffFields(before ? view(before) : null, after ? view(after) : null, labels);
    recordActivity(s, { source, records: [{ type: 'PRODUCT', id: rec.id, name: rec.name, op, rows: fields.length || op !== 'UPDATE' ? [{ entity: 'PRODUCT', entity_label: 'Product', op, row_id: rec.id, row_label: null, fields }] : [] }] });
    if (!after) this.ctx.webhooks.emit('PRODUCT', 'DELETE', rec.id);
    else this.ctx.webhooks.emit('PRODUCT', before ? 'UPDATE' : 'CREATE', rec.id, computeChanges(beforeApi, this.ser.product(after)));
  }

  /** Records a PDF email in the outbox (never sends anything). */
  emailPdf(input: { document: string; recordId: string; recordName: string; to: string[] }, source: ActivitySource) {
    const entry = {
      id: this.s.newId(),
      at: this.s.nowIso(),
      source,
      document: input.document,
      record_id: input.recordId,
      to: input.to,
      subject: `${input.document.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())} ${input.recordName} from ${this.s.selfCompanyName}`,
    };
    this.s.outbox.push(entry);
    return entry;
  }
}
