import type {
  ActivityRec,
  BatchRec,
  CategoryRec,
  CompanyRec,
  CustomFieldDefRec,
  DeletedRecordRec,
  InvoiceRec,
  LicenseRec,
  LocationRec,
  LotRec,
  McpTelemetryEntry,
  MenuRec,
  OrderRec,
  OutboxEntry,
  PaymentMethodRec,
  PaymentRec,
  ProductRec,
  PurchaseRec,
  SeedSummary,
  StockAdjustmentRec,
  TaskRec,
  TestResultRec,
  UserRec,
  WebhookLogEntry,
} from './types';

const HEX = Array.from({ length: 256 }, (_, b) => b.toString(16).padStart(2, '0'));

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)]!,
    uuid: () => {
      let s = '';
      for (let i = 0; i < 16; i++) {
        let b = Math.floor(next() * 256);
        if (i === 6) b = (b & 0x0f) | 0x40;
        else if (i === 8) b = (b & 0x3f) | 0x80;
        s += HEX[b]!;
        if (i === 3 || i === 5 || i === 7 || i === 9) s += '-';
      }
      return s;
    },
    poisson: (lambda: number) => {
      if (lambda <= 0) return 0;
      const L = Math.exp(-lambda);
      let k = 0;
      let p = 1;
      do {
        k++;
        p *= next();
      } while (p > L);
      return k - 1;
    },
  };
}
export type Rng = ReturnType<typeof rng>;

export class Store {
  licenses = new Map<string, LicenseRec>();
  locations = new Map<string, LocationRec>();
  companies = new Map<string, CompanyRec>();
  categories = new Map<string, CategoryRec>();
  products = new Map<string, ProductRec>();
  batches = new Map<string, BatchRec>();
  lots = new Map<string, LotRec>();
  testResults = new Map<string, TestResultRec>();
  orders = new Map<string, OrderRec>();
  purchases = new Map<string, PurchaseRec>();
  users = new Map<string, UserRec>();
  menus = new Map<string, MenuRec>();
  tasks = new Map<string, TaskRec>();
  customFields = new Map<number, CustomFieldDefRec>();
  adjustments = new Map<string, StockAdjustmentRec>();
  /** accounts receivable: invoices (one per billed sales order), payments against them, payment methods */
  invoices = new Map<string, InvoiceRec>();
  payments = new Map<string, PaymentRec>();
  paymentMethods = new Map<string, PaymentMethodRec>();
  /** order id → its invoice ids */
  invoiceIdsByOrder = new Map<string, string[]>();
  /** tombstones for GET /deleted-records (kept 90 days in Distru) */
  deletedRecords: DeletedRecordRec[] = [];
  /** operations, newest last: feeds GET /activity, GET /record-history and the MCP history tools */
  activity: ActivityRec[] = [];
  /** emails the mock pretended to send */
  outbox: OutboxEntry[] = [];
  /** `intent` / `userSatisfactionEstimate` logged per MCP tool call */
  mcpTelemetry: McpTelemetryEntry[] = [];
  webhookLog: WebhookLogEntry[] = [];
  /** our own company's id (owner of our locations) */
  selfCompanyId = '';
  selfCompanyName = SELF_COMPANY.name;
  /** the user the REST token and the MCP key act as */
  apiUserId = '';
  ownLocationIds: string[] = [];
  /** time the seed is anchored to */
  now: Date = new Date();
  summary: SeedSummary | null = null;
  counters = { order: 1000, purchase: 500, metrcPackage: 900000, metrcTransfer: 70000, customField: 4820, metrcActivity: 310000, invoice: 10000, payment: 50000, credit: 700 };
  /** id generator for records created at runtime (random, unlike the seed's deterministic ids) */
  newId: () => string = () => crypto.randomUUID();

  nowIso(): string {
    return new Date().toISOString();
  }

  /** Real time the store was created, so business time can advance from the seed's anchor. */
  readonly createdAt = Date.now();

  /**
   * "Now" in the seeded business world: the anchor plus the time elapsed since seeding. Without a fixed
   * anchor (MOCK_NOW) it's the wall clock; with one (evals), business dates like a new order's date stay
   * on the anchored day instead of drifting with the real calendar.
   */
  businessNow(): Date {
    return new Date(this.now.getTime() + (Date.now() - this.createdAt));
  }

  lotsForProduct(productId: string): LotRec[] {
    return [...this.lots.values()].filter((l) => l.product_id === productId);
  }

  quantityActive(productId: string, locationIds?: string[]): number {
    return this.lotsForProduct(productId)
      .filter((l) => !locationIds?.length || locationIds.includes(l.location_id))
      .reduce((s, l) => s + l.quantity, 0);
  }

  /** Reserved = quantity on open (unfulfilled) sales orders. */
  quantityReserved(productId: string, locationIds?: string[]): number {
    let s = 0;
    for (const o of this.orders.values()) {
      if (!OPEN_ORDER_STATUSES.has(o.status)) continue;
      for (const i of o.items) {
        if (i.product_id === productId && (!locationIds?.length || locationIds.includes(i.location_id))) s += i.quantity;
      }
    }
    return s;
  }

  /** Sum of an invoice's active (posted) payments. */
  invoicePaid(invoiceId: string): number {
    let s = 0;
    for (const p of this.paymentsOf(invoiceId)) if (p.status === 'POSTED') s += p.amount;
    return Math.round(s * 100) / 100;
  }

  /** An invoice's payments (posted and voided), oldest first. */
  paymentsOf(invoiceId: string): PaymentRec[] {
    return this.#paymentsByInvoice.get(invoiceId) ?? [];
  }

  addPayment(p: PaymentRec): void {
    this.payments.set(p.id, p);
    const list = this.#paymentsByInvoice.get(p.invoice_id) ?? [];
    list.push(p);
    list.sort((a, b) => (a.payment_datetime === b.payment_datetime ? a.payment_number.localeCompare(b.payment_number) : a.payment_datetime < b.payment_datetime ? -1 : 1));
    this.#paymentsByInvoice.set(p.invoice_id, list);
  }

  #paymentsByInvoice = new Map<string, PaymentRec[]>();

  /** Units still to receive on open purchases (excluding drafts). */
  quantityIncoming(productId: string, opts: { olderThan?: Date; newerThan?: Date; locationIds?: string[] } = {}): number {
    let s = 0;
    for (const p of this.purchases.values()) {
      if (!OPEN_PURCHASE_STATUSES.has(p.status) || !p.order_datetime) continue;
      const at = new Date(p.order_datetime);
      if (opts.olderThan && !(at < opts.olderThan)) continue;
      if (opts.newerThan && !(at >= opts.newerThan)) continue;
      for (const i of p.items) {
        const pid = i.product_id ?? (i.batch_id ? this.batches.get(i.batch_id)?.product_id : null);
        if (pid !== productId) continue;
        if (opts.locationIds?.length && (!i.location_id || !opts.locationIds.includes(i.location_id))) continue;
        s += Math.max(0, i.quantity - i.received_quantity);
      }
    }
    return s;
  }
}

export const SELF_COMPANY = { name: 'Golden Coast Distribution', legal_business_name: 'Golden Coast Distribution LLC', timezone: 'America/Los_Angeles', us_state: 'CA' };

export const OPEN_ORDER_STATUSES = new Set(['PENDING', 'PROCESSING', 'READY_TO_SHIP', 'DELIVERING']);
export const OPEN_PURCHASE_STATUSES = new Set(['PENDING', 'PROCESSING', 'DELIVERING', 'PARTIALLY_RECEIVED']);
