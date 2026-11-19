/**
 * Boundary types of the context layer (zod first, `z.infer` everywhere).
 *
 * Every unified-layer row carries `source` + `sourceId`, so Distru, Headset, email and any future
 * connector land in the same tables without id collisions. Ids that point at other records
 * (`vendorId`, `productId`, ...) are source ids within the same `source`.
 */
import { z } from 'zod';

export const IsoDate = z.string();

// ── unified layer ────────────────────────────────────────────────────────────────────────────

const rowBase = {
  source: z.string().min(1),
  sourceId: z.string().min(1),
  /** `updated_datetime` as the source reports it. */
  sourceUpdatedAt: IsoDate.nullable(),
  syncedAt: IsoDate,
  /** Soft delete (deleted-records feed, 404 on refetch, or missing on a full reconcile). */
  deletedAt: IsoDate.nullable(),
};

export const ProductRowSchema = z.object({
  ...rowBase,
  sku: z.string().nullable(),
  name: z.string(),
  category: z.string().nullable(),
  vendorId: z.string().nullable(),
  unitCost: z.number().nullable(),
  unitPrice: z.number().nullable(),
  unitsPerCase: z.number().nullable(),
  isActive: z.boolean(),
});
export type ProductRow = z.infer<typeof ProductRowSchema>;

export const CompanyRelationshipSchema = z.enum(['vendor', 'customer', 'other']);
export type CompanyRelationship = z.infer<typeof CompanyRelationshipSchema>;

export const CompanyRowSchema = z.object({
  ...rowBase,
  name: z.string(),
  relationship: CompanyRelationshipSchema,
  category: z.string().nullable(),
  email: z.string().nullable(),
  /** Lead time the vendor promises (parsed from PO notes / a custom field); null when unknown. */
  promisedLeadTimeDays: z.number().nullable(),
});
export type CompanyRow = z.infer<typeof CompanyRowSchema>;

export const PurchaseLineSchema = z.object({
  lineId: z.string(),
  productId: z.string().nullable(),
  quantity: z.number(),
  receivedQuantity: z.number(),
  unitPrice: z.number().nullable(),
});
export type PurchaseLine = z.infer<typeof PurchaseLineSchema>;

/** How `receivedAt` was obtained: seen transitioning to COMPLETED, or estimated from `updated_datetime`. */
export const ReceivedAtSourceSchema = z.enum(['observed', 'updated_datetime']);

export const PurchaseRowSchema = z.object({
  ...rowBase,
  number: z.string().nullable(),
  status: z.string(),
  vendorId: z.string().nullable(),
  locationId: z.string().nullable(),
  orderedAt: IsoDate.nullable(),
  receivedAt: IsoDate.nullable(),
  receivedAtSource: ReceivedAtSourceSchema.nullable(),
  total: z.number().nullable(),
  lines: z.array(PurchaseLineSchema),
});
export type PurchaseRow = z.infer<typeof PurchaseRowSchema>;

export const OrderLineSchema = z.object({
  lineId: z.string(),
  productId: z.string().nullable(),
  locationId: z.string().nullable(),
  quantity: z.number(),
  unitPrice: z.number().nullable(),
});
export type OrderLine = z.infer<typeof OrderLineSchema>;

export const OrderRowSchema = z.object({
  ...rowBase,
  number: z.string().nullable(),
  status: z.string(),
  customerId: z.string().nullable(),
  locationId: z.string().nullable(),
  orderedAt: IsoDate.nullable(),
  deliveredAt: IsoDate.nullable(),
  total: z.number().nullable(),
  lines: z.array(OrderLineSchema),
});
export type OrderRow = z.infer<typeof OrderRowSchema>;

export const EntityKindSchema = z.enum(['product', 'company', 'purchase', 'order']);
export type EntityKind = z.infer<typeof EntityKindSchema>;

export interface EntityRowMap {
  product: ProductRow;
  company: CompanyRow;
  purchase: PurchaseRow;
  order: OrderRow;
}

export const InventoryRowSchema = z.object({
  productId: z.string(),
  /** '' when the source does not group by location. */
  locationId: z.string(),
  active: z.number(),
  reserved: z.number(),
  available: z.number(),
});
export type InventoryRow = z.infer<typeof InventoryRowSchema>;

export const InventorySnapshotSchema = z.object({
  source: z.string(),
  snapshotAt: IsoDate,
  rows: z.array(InventoryRowSchema),
});
export type InventorySnapshot = z.infer<typeof InventorySnapshotSchema>;

/** Generic time-series fact from any connector (Headset sell-through, email signals, ...). */
export const FactSchema = z.object({
  source: z.string().min(1),
  /** e.g. `product`, `vendor`, `customer`, `store`. */
  entityType: z.string().min(1),
  /** Natural key in that source (Headset: SKU). */
  entityKey: z.string().min(1),
  metric: z.string().min(1),
  value: z.number(),
  observedAt: IsoDate,
});
export type Fact = z.infer<typeof FactSchema>;

// ── sync bookkeeping ─────────────────────────────────────────────────────────────────────────

export const SyncStreamSchema = z.enum(['companies', 'products', 'purchases', 'orders']);
export type SyncStream = z.infer<typeof SyncStreamSchema>;

export const StreamStatsSchema = z.object({
  mode: z.enum(['full', 'incremental', 'reconcile']),
  /** `updated_datetime` lower bound used (null on a full load). */
  lowerBound: IsoDate.nullable(),
  pages: z.number().int(),
  /** Pages that cost list budget (lower bound missing or older than the free window). */
  paidPages: z.number().int(),
  fetched: z.number().int(),
  deleted: z.number().int(),
});
export type StreamStats = z.infer<typeof StreamStatsSchema>;

export const SyncCursorSchema = z.object({
  source: z.string(),
  stream: z.string(),
  /** Start time of the last successful run of this stream (the next lower bound is this − overlap). */
  cursorAt: IsoDate,
  lastFullAt: IsoDate,
  lastRunAt: IsoDate,
  lastStats: StreamStatsSchema.nullable(),
});
export type SyncCursor = z.infer<typeof SyncCursorSchema>;

export const SyncRunSchema = z.object({
  id: z.string(),
  source: z.string(),
  kind: z.enum(['auto', 'full', 'reconcile', 'record']),
  status: z.enum(['ok', 'failed', 'deferred']),
  startedAt: IsoDate,
  finishedAt: IsoDate,
  stats: z.record(z.string(), z.unknown()),
  error: z.string().nullable(),
});
export type SyncRun = z.infer<typeof SyncRunSchema>;

export const WebhookEventKeySchema = z.object({
  source: z.string(),
  type: z.string(),
  recordId: z.string(),
  occurredAt: z.string(),
});
export type WebhookEventKey = z.infer<typeof WebhookEventKeySchema>;

// ── memories ─────────────────────────────────────────────────────────────────────────────────

export const MemoryScopeSchema = z.enum(['vendor', 'product', 'customer', 'global']);
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

export const MemoryEvidenceSchema = z.object({
  proposalIds: z.array(z.string()),
  auditIds: z.array(z.string()),
  /** Free-form references (e.g. a Copilot thread id) for explicit memories. */
  refs: z.array(z.string()),
});
export type MemoryEvidence = z.infer<typeof MemoryEvidenceSchema>;

export const MemorySchema = z.object({
  id: z.string(),
  scope: MemoryScopeSchema,
  /** Source id of the vendor/product/customer; null for global. */
  scopeId: z.string().nullable(),
  /** Stable key of what was learned (`qty_trim`, `rejection:price`, `policy:max_total_value`, ...). */
  key: z.string(),
  statement: z.string(),
  evidence: MemoryEvidenceSchema,
  evidenceCount: z.number().int(),
  /** 0..1 at `lastConfirmedAt`; retrieval applies time decay on top. */
  confidence: z.number().min(0).max(1),
  origin: z.enum(['learned', 'explicit']),
  status: z.enum(['active', 'expired', 'retracted']),
  /** Numbers behind the statement (e.g. `{ trims: 4, edits: 5, medianPct: -20 }`). */
  data: z.record(z.string(), z.union([z.number(), z.string(), z.null()])),
  createdAt: IsoDate,
  lastConfirmedAt: IsoDate,
  expiresAt: IsoDate.nullable(),
});
export type Memory = z.infer<typeof MemorySchema>;

// ── harness signals (what the memory learner consumes) ───────────────────────────────────────

export const SignalActorSchema = z.object({ kind: z.string(), id: z.string(), label: z.string().optional() });

export const LineQtySchema = z.object({
  productId: z.string().nullable(),
  quantity: z.number(),
  unitPrice: z.number().nullable().optional(),
});
export type LineQty = z.infer<typeof LineQtySchema>;

export const SignalOpSchema = z.object({
  index: z.number().int(),
  action: z.string(),
  vendorIds: z.array(z.string()),
  /** Lines as the agent proposed them. */
  proposed: z.array(LineQtySchema),
  /** Lines as finally approved (after approver edits); equals `proposed` when not edited. */
  final: z.array(LineQtySchema),
});
export type SignalOp = z.infer<typeof SignalOpSchema>;

const signalBase = {
  /** Unique per signal (usually the harness audit event id); ingestion is idempotent on it. */
  id: z.string(),
  at: IsoDate,
};

export const HarnessSignalSchema = z.discriminatedUnion('kind', [
  z.object({
    ...signalBase,
    kind: z.literal('decision'),
    proposalId: z.string(),
    decision: z.enum(['approve', 'reject']),
    reason: z.string().nullable(),
    edited: z.boolean(),
    by: SignalActorSchema,
    ops: z.array(SignalOpSchema),
  }),
  z.object({
    ...signalBase,
    kind: z.literal('policy_denied'),
    proposalId: z.string(),
    vendorIds: z.array(z.string()),
    productIds: z.array(z.string()),
    rules: z.array(z.string()),
    messages: z.array(z.string()),
  }),
  z.object({
    ...signalBase,
    kind: z.literal('compliance_veto'),
    proposalId: z.string(),
    vendorIds: z.array(z.string()),
    productIds: z.array(z.string()),
    reason: z.string().nullable(),
    by: SignalActorSchema,
  }),
  z.object({
    ...signalBase,
    kind: z.literal('policy_rule_changed'),
    key: z.string(),
    before: z.record(z.string(), z.unknown()).nullable(),
    after: z.record(z.string(), z.unknown()).nullable(),
    by: SignalActorSchema,
  }),
]);
export type HarnessSignal = z.infer<typeof HarnessSignalSchema>;
export type HarnessSignalOf<K extends HarnessSignal['kind']> = Extract<HarnessSignal, { kind: K }>;

// ── profile snapshot ─────────────────────────────────────────────────────────────────────────

export const PriceTrendSchema = z.object({
  productId: z.string(),
  sku: z.string().nullable(),
  name: z.string().nullable(),
  lastPrice: z.number(),
  lastOrderedAt: IsoDate,
  avg90d: z.number().nullable(),
  changePct: z.number().nullable(),
  samples90d: z.number().int(),
});

export const VendorProfileSchema = z.object({
  vendorId: z.string(),
  name: z.string(),
  promisedLeadTimeDays: z.number().nullable(),
  actualLeadTimeDays: z.number().nullable(),
  leadTimeP90Days: z.number().nullable(),
  leadTimeSamples: z.number().int(),
  onTimePct: z.number().nullable(),
  fillRatePct: z.number().nullable(),
  purchaseCount: z.number().int(),
  openPurchaseCount: z.number().int(),
  avgPurchaseTotal: z.number().nullable(),
  lastOrderedAt: IsoDate.nullable(),
  priceTrends: z.array(PriceTrendSchema),
});
export type VendorProfile = z.infer<typeof VendorProfileSchema>;

export const ProductProfileSchema = z.object({
  productId: z.string(),
  sku: z.string().nullable(),
  name: z.string(),
  vendorId: z.string().nullable(),
  isActive: z.boolean(),
  unitsPerDay28d: z.number(),
  unitsPerDayPrior28d: z.number(),
  demandTrendPct: z.number().nullable(),
  demandDirection: z.enum(['up', 'down', 'flat', 'none']),
  /** Units by weekday (0=Sun) over the last 12 weeks, as a ratio to the weekday mean. */
  weekdayIndex: z.array(z.number()),
  seasonalityHint: z.string().nullable(),
  available: z.number().nullable(),
  daysOfSupply: z.number().nullable(),
  retail: z
    .object({
      source: z.string(),
      observedAt: IsoDate,
      metrics: z.record(z.string(), z.number()),
    })
    .nullable(),
});
export type ProductProfile = z.infer<typeof ProductProfileSchema>;

export const CustomerProfileSchema = z.object({
  customerId: z.string(),
  name: z.string(),
  orderCount: z.number().int(),
  orderCount90d: z.number().int(),
  cadenceDays: z.number().nullable(),
  lastOrderAt: IsoDate.nullable(),
  daysSinceLastOrder: z.number().nullable(),
  overdue: z.boolean(),
  avgOrderTotal: z.number().nullable(),
  topSkus: z.array(z.object({ productId: z.string(), sku: z.string().nullable(), name: z.string().nullable(), units90d: z.number() })),
});
export type CustomerProfile = z.infer<typeof CustomerProfileSchema>;

export const ProfileSnapshotSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  computedAt: IsoDate,
  source: z.string(),
  counts: z.object({ vendors: z.number().int(), products: z.number().int(), customers: z.number().int(), purchases: z.number().int(), orders: z.number().int() }),
  vendors: z.array(VendorProfileSchema),
  products: z.array(ProductProfileSchema),
  customers: z.array(CustomerProfileSchema),
});
export type ProfileSnapshot = z.infer<typeof ProfileSnapshotSchema>;
