/**
 * Drizzle schema of the context layer. Everything lives in the Postgres schema `context`, apart from
 * the app's `public` tables and Mastra's `mastra` schema. Add this file to drizzle-kit's `schema`
 * list and `'context'` to `schemaFilter` (see `contextDrizzleConfig`).
 */
import type { HarnessSignal, Memory, MemoryEvidence, ProfileSnapshot, StreamStats } from '../model';
import { bigserial, boolean, doublePrecision, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const contextSchema = pgSchema('context');

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });

const rowBase = {
  source: text('source').notNull(),
  sourceId: text('source_id').notNull(),
  sourceUpdatedAt: ts('source_updated_at'),
  syncedAt: ts('synced_at').notNull(),
  deletedAt: ts('deleted_at'),
};

export const products = contextSchema.table(
  'products',
  {
    ...rowBase,
    sku: text('sku'),
    name: text('name').notNull(),
    category: text('category'),
    vendorId: text('vendor_id'),
    unitCost: doublePrecision('unit_cost'),
    unitPrice: doublePrecision('unit_price'),
    unitsPerCase: doublePrecision('units_per_case'),
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.source, t.sourceId] }), index('products_sku_idx').on(t.sku), index('products_vendor_idx').on(t.source, t.vendorId)],
);

export const companies = contextSchema.table(
  'companies',
  {
    ...rowBase,
    name: text('name').notNull(),
    relationship: text('relationship', { enum: ['vendor', 'customer', 'other'] }).notNull(),
    category: text('category'),
    email: text('email'),
    promisedLeadTimeDays: doublePrecision('promised_lead_time_days'),
  },
  (t) => [primaryKey({ columns: [t.source, t.sourceId] }), index('companies_relationship_idx').on(t.source, t.relationship)],
);

export const purchases = contextSchema.table(
  'purchases',
  {
    ...rowBase,
    number: text('number'),
    status: text('status').notNull(),
    vendorId: text('vendor_id'),
    locationId: text('location_id'),
    orderedAt: ts('ordered_at'),
    receivedAt: ts('received_at'),
    receivedAtSource: text('received_at_source', { enum: ['observed', 'updated_datetime'] }),
    total: doublePrecision('total'),
  },
  (t) => [primaryKey({ columns: [t.source, t.sourceId] }), index('purchases_vendor_ordered_idx').on(t.source, t.vendorId, t.orderedAt)],
);

export const purchaseLines = contextSchema.table(
  'purchase_lines',
  {
    source: text('source').notNull(),
    purchaseId: text('purchase_id').notNull(),
    lineId: text('line_id').notNull(),
    position: integer('position').notNull(),
    productId: text('product_id'),
    quantity: doublePrecision('quantity').notNull(),
    receivedQuantity: doublePrecision('received_quantity').notNull(),
    unitPrice: doublePrecision('unit_price'),
  },
  (t) => [primaryKey({ columns: [t.source, t.purchaseId, t.lineId] }), index('purchase_lines_product_idx').on(t.source, t.productId)],
);

export const orders = contextSchema.table(
  'orders',
  {
    ...rowBase,
    number: text('number'),
    status: text('status').notNull(),
    customerId: text('customer_id'),
    locationId: text('location_id'),
    orderedAt: ts('ordered_at'),
    deliveredAt: ts('delivered_at'),
    total: doublePrecision('total'),
  },
  (t) => [primaryKey({ columns: [t.source, t.sourceId] }), index('orders_customer_ordered_idx').on(t.source, t.customerId, t.orderedAt), index('orders_ordered_idx').on(t.source, t.orderedAt)],
);

export const orderLines = contextSchema.table(
  'order_lines',
  {
    source: text('source').notNull(),
    orderId: text('order_id').notNull(),
    lineId: text('line_id').notNull(),
    position: integer('position').notNull(),
    productId: text('product_id'),
    locationId: text('location_id'),
    quantity: doublePrecision('quantity').notNull(),
    unitPrice: doublePrecision('unit_price'),
  },
  (t) => [primaryKey({ columns: [t.source, t.orderId, t.lineId] }), index('order_lines_product_idx').on(t.source, t.productId)],
);

export const inventorySnapshots = contextSchema.table(
  'inventory_snapshots',
  {
    source: text('source').notNull(),
    snapshotAt: ts('snapshot_at').notNull(),
    productId: text('product_id').notNull(),
    locationId: text('location_id').notNull().default(''),
    active: doublePrecision('active').notNull(),
    reserved: doublePrecision('reserved').notNull(),
    available: doublePrecision('available').notNull(),
  },
  (t) => [primaryKey({ name: 'inventory_snapshots_pk', columns: [t.source, t.snapshotAt, t.productId, t.locationId] }), index('inventory_latest_idx').on(t.source, t.snapshotAt)],
);

export const facts = contextSchema.table(
  'facts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    source: text('source').notNull(),
    entityType: text('entity_type').notNull(),
    entityKey: text('entity_key').notNull(),
    metric: text('metric').notNull(),
    value: doublePrecision('value').notNull(),
    observedAt: ts('observed_at').notNull(),
    ingestedAt: ts('ingested_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('facts_natural_key').on(t.source, t.entityType, t.entityKey, t.metric, t.observedAt), index('facts_entity_idx').on(t.entityType, t.entityKey)],
);

export const syncCursors = contextSchema.table(
  'sync_cursors',
  {
    source: text('source').notNull(),
    stream: text('stream').notNull(),
    cursorAt: ts('cursor_at').notNull(),
    lastFullAt: ts('last_full_at').notNull(),
    lastRunAt: ts('last_run_at').notNull(),
    lastStats: jsonb('last_stats').$type<StreamStats>(),
  },
  (t) => [primaryKey({ columns: [t.source, t.stream] })],
);

export const syncRuns = contextSchema.table(
  'sync_runs',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(),
    kind: text('kind', { enum: ['auto', 'full', 'reconcile', 'record'] }).notNull(),
    status: text('status', { enum: ['ok', 'failed', 'deferred'] }).notNull(),
    startedAt: ts('started_at').notNull(),
    finishedAt: ts('finished_at').notNull(),
    stats: jsonb('stats').$type<Record<string, unknown>>().notNull(),
    error: text('error'),
  },
  (t) => [index('sync_runs_started_idx').on(t.startedAt)],
);

export const webhookEvents = contextSchema.table(
  'webhook_events',
  {
    source: text('source').notNull(),
    type: text('type').notNull(),
    recordId: text('record_id').notNull(),
    /** Exactly as delivered (the dedupe triple is string-identical). */
    occurredAt: text('occurred_at').notNull(),
    receivedAt: ts('received_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.source, t.type, t.recordId, t.occurredAt] })],
);

export const harnessSignals = contextSchema.table(
  'harness_signals',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    at: ts('at').notNull(),
    proposalId: text('proposal_id'),
    payload: jsonb('payload').$type<HarnessSignal>().notNull(),
    ingestedAt: ts('ingested_at').notNull().defaultNow(),
  },
  (t) => [index('harness_signals_at_idx').on(t.at)],
);

export const memories = contextSchema.table(
  'memories',
  {
    id: text('id').primaryKey(),
    scope: text('scope', { enum: ['vendor', 'product', 'customer', 'global'] }).notNull(),
    scopeId: text('scope_id'),
    key: text('key').notNull(),
    statement: text('statement').notNull(),
    evidence: jsonb('evidence').$type<MemoryEvidence>().notNull(),
    evidenceCount: integer('evidence_count').notNull(),
    confidence: doublePrecision('confidence').notNull(),
    origin: text('origin', { enum: ['learned', 'explicit'] }).notNull(),
    status: text('status', { enum: ['active', 'expired', 'retracted'] }).notNull(),
    data: jsonb('data').$type<Memory['data']>().notNull(),
    createdAt: ts('created_at').notNull(),
    lastConfirmedAt: ts('last_confirmed_at').notNull(),
    expiresAt: ts('expires_at'),
  },
  (t) => [index('memories_scope_idx').on(t.scope, t.scopeId), index('memories_status_idx').on(t.status)],
);

export const profileSnapshots = contextSchema.table(
  'profile_snapshots',
  {
    id: text('id').primaryKey(),
    version: integer('version').notNull(),
    computedAt: ts('computed_at').notNull(),
    source: text('source').notNull(),
    profile: jsonb('profile').$type<Omit<ProfileSnapshot, 'version' | 'id' | 'computedAt' | 'source'>>().notNull(),
  },
  (t) => [uniqueIndex('profile_snapshots_version_idx').on(t.version)],
);

/** Every table, for `drizzle(sql, { schema: { ...appSchema, ...contextTables } })`. */
export const contextTables = {
  contextSchema,
  products,
  companies,
  purchases,
  purchaseLines,
  orders,
  orderLines,
  inventorySnapshots,
  facts,
  syncCursors,
  syncRuns,
  webhookEvents,
  harnessSignals,
  memories,
  profileSnapshots,
};
