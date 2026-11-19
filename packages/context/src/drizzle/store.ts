/**
 * `ContextStore` on Postgres via Drizzle (tables in schema `context`, see ./schema.ts).
 *
 * ```ts
 * import { drizzle } from 'drizzle-orm/postgres-js';
 * import { DrizzleContextStore } from '@ops/context/drizzle';
 * const store = new DrizzleContextStore(drizzle(sql));
 * ```
 */
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNull, lte, max, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgDatabase, PgQueryResultHKT, PgTable } from 'drizzle-orm/pg-core';
import type {
  CompanyRow,
  EntityKind,
  EntityRowMap,
  Fact,
  HarnessSignal,
  InventorySnapshot,
  Memory,
  OrderRow,
  ProductRow,
  ProfileSnapshot,
  PurchaseRow,
  SyncCursor,
  SyncRun,
  WebhookEventKey,
} from '../model';
import type { ContextStore, EntityQuery, FactQuery, MemoryQuery } from '../store';
import * as t from './schema';

const INVENTORY_STREAM = 'inventory:snapshot';
const CHUNK = 1000;

/** Postgres returns `2026-11-19 12:00:00+00`; the context layer speaks ISO-8601 UTC. */
const isoOf = (v: string): string => new Date(v.includes('T') ? v : v.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')).toISOString();
const isoOrNull = (v: string | null): string | null => (v === null ? null : isoOf(v));

function chunks<T>(xs: readonly T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** `ON CONFLICT DO UPDATE SET col = excluded.col` for every column except the keys. */
function excludedSet(table: PgTable, keep: readonly string[]): Record<string, SQL> {
  const set: Record<string, SQL> = {};
  for (const [prop, col] of Object.entries(getTableColumns(table)) as [string, PgColumn][]) {
    if (keep.includes(prop)) continue;
    set[prop] = sql.raw(`excluded."${col.name}"`);
  }
  return set;
}

export class DrizzleContextStore<H extends PgQueryResultHKT, S extends Record<string, unknown>> implements ContextStore {
  constructor(private readonly db: PgDatabase<H, S>) {}

  // ── unified layer ──────────────────────────────────────────────────────────────────────────

  async upsert<K extends EntityKind>(kind: K, rows: readonly EntityRowMap[K][]): Promise<void> {
    if (!rows.length) return;
    switch (kind) {
      case 'product':
        for (const c of chunks(rows as readonly ProductRow[])) {
          await this.db.insert(t.products).values(c).onConflictDoUpdate({ target: [t.products.source, t.products.sourceId], set: excludedSet(t.products, ['source', 'sourceId']) });
        }
        return;
      case 'company':
        for (const c of chunks(rows as readonly CompanyRow[])) {
          await this.db.insert(t.companies).values(c).onConflictDoUpdate({ target: [t.companies.source, t.companies.sourceId], set: excludedSet(t.companies, ['source', 'sourceId']) });
        }
        return;
      case 'purchase':
        for (const c of chunks(rows as readonly PurchaseRow[], 200)) {
          await this.db.transaction(async (tx) => {
            await tx
              .insert(t.purchases)
              .values(c.map(({ lines: _lines, ...h }) => h))
              .onConflictDoUpdate({ target: [t.purchases.source, t.purchases.sourceId], set: excludedSet(t.purchases, ['source', 'sourceId']) });
            for (const [source, group] of groupBySource(c)) {
              await tx.delete(t.purchaseLines).where(and(eq(t.purchaseLines.source, source), inArray(t.purchaseLines.purchaseId, group.map((p) => p.sourceId))));
            }
            const lines = c.flatMap((p) => p.lines.map((l, position) => ({ source: p.source, purchaseId: p.sourceId, position, ...l })));
            for (const lc of chunks(lines)) await tx.insert(t.purchaseLines).values(lc);
          });
        }
        return;
      case 'order':
        for (const c of chunks(rows as readonly OrderRow[], 200)) {
          await this.db.transaction(async (tx) => {
            await tx
              .insert(t.orders)
              .values(c.map(({ lines: _lines, ...h }) => h))
              .onConflictDoUpdate({ target: [t.orders.source, t.orders.sourceId], set: excludedSet(t.orders, ['source', 'sourceId']) });
            for (const [source, group] of groupBySource(c)) {
              await tx.delete(t.orderLines).where(and(eq(t.orderLines.source, source), inArray(t.orderLines.orderId, group.map((o) => o.sourceId))));
            }
            const lines = c.flatMap((o) => o.lines.map((l, position) => ({ source: o.source, orderId: o.sourceId, position, ...l })));
            for (const lc of chunks(lines)) await tx.insert(t.orderLines).values(lc);
          });
        }
        return;
    }
  }

  #table(kind: EntityKind) {
    return kind === 'product' ? t.products : kind === 'company' ? t.companies : kind === 'purchase' ? t.purchases : t.orders;
  }

  async markDeleted(kind: EntityKind, source: string, sourceIds: readonly string[], at: string): Promise<number> {
    const table = this.#table(kind);
    let n = 0;
    for (const c of chunks(sourceIds)) {
      const res = await this.db
        .update(table)
        .set({ deletedAt: at })
        .where(and(eq(table.source, source), inArray(table.sourceId, c), isNull(table.deletedAt)))
        .returning({ id: table.sourceId });
      n += res.length;
    }
    return n;
  }

  #where(kind: EntityKind, q: EntityQuery): SQL | undefined {
    const table = this.#table(kind);
    const conds: (SQL | undefined)[] = [];
    if (!q.includeDeleted) conds.push(isNull(table.deletedAt));
    if (q.source) conds.push(eq(table.source, q.source));
    if (q.ids) conds.push(q.ids.length ? inArray(table.sourceId, [...q.ids]) : sql`false`);
    if (q.partyIds) {
      const col = kind === 'order' ? t.orders.customerId : kind === 'purchase' ? t.purchases.vendorId : kind === 'product' ? t.products.vendorId : null;
      conds.push(col && q.partyIds.length ? inArray(col, [...q.partyIds]) : sql`false`);
    }
    if (q.statuses) {
      const col = kind === 'order' ? t.orders.status : kind === 'purchase' ? t.purchases.status : null;
      conds.push(col && q.statuses.length ? inArray(col, [...q.statuses]) : sql`false`);
    }
    if (q.from || q.to) {
      const col = kind === 'order' ? t.orders.orderedAt : kind === 'purchase' ? t.purchases.orderedAt : null;
      if (!col) conds.push(sql`false`);
      else {
        if (q.from) conds.push(gte(col, q.from));
        if (q.to) conds.push(lte(col, q.to));
      }
    }
    return and(...conds);
  }

  async list<K extends EntityKind>(kind: K, query: EntityQuery = {}): Promise<EntityRowMap[K][]> {
    const where = this.#where(kind, query);
    switch (kind) {
      case 'product': {
        const rows = await this.db.select().from(t.products).where(where);
        return rows.map((r): ProductRow => ({ ...r, sourceUpdatedAt: isoOrNull(r.sourceUpdatedAt), syncedAt: isoOf(r.syncedAt), deletedAt: isoOrNull(r.deletedAt) })) as EntityRowMap[K][];
      }
      case 'company': {
        const rows = await this.db.select().from(t.companies).where(where);
        return rows.map((r): CompanyRow => ({ ...r, sourceUpdatedAt: isoOrNull(r.sourceUpdatedAt), syncedAt: isoOf(r.syncedAt), deletedAt: isoOrNull(r.deletedAt) })) as EntityRowMap[K][];
      }
      case 'purchase': {
        const rows = await this.db.select().from(t.purchases).where(where);
        const lines = new Map<string, PurchaseRow['lines']>();
        for (const c of chunks(rows)) {
          for (const [source, group] of groupBySource(c)) {
            const ls = await this.db
              .select()
              .from(t.purchaseLines)
              .where(and(eq(t.purchaseLines.source, source), inArray(t.purchaseLines.purchaseId, group.map((p) => p.sourceId))))
              .orderBy(asc(t.purchaseLines.purchaseId), asc(t.purchaseLines.position));
            for (const l of ls) {
              const k = `${l.source}\u0000${l.purchaseId}`;
              lines.set(k, [...(lines.get(k) ?? []), { lineId: l.lineId, productId: l.productId, quantity: l.quantity, receivedQuantity: l.receivedQuantity, unitPrice: l.unitPrice }]);
            }
          }
        }
        return rows.map(
          (r): PurchaseRow => ({
            ...r,
            orderedAt: isoOrNull(r.orderedAt),
            receivedAt: isoOrNull(r.receivedAt),
            sourceUpdatedAt: isoOrNull(r.sourceUpdatedAt),
            syncedAt: isoOf(r.syncedAt),
            deletedAt: isoOrNull(r.deletedAt),
            lines: lines.get(`${r.source}\u0000${r.sourceId}`) ?? [],
          }),
        ) as EntityRowMap[K][];
      }
      case 'order': {
        const rows = await this.db.select().from(t.orders).where(where);
        const lines = new Map<string, OrderRow['lines']>();
        for (const c of chunks(rows)) {
          for (const [source, group] of groupBySource(c)) {
            const ls = await this.db
              .select()
              .from(t.orderLines)
              .where(and(eq(t.orderLines.source, source), inArray(t.orderLines.orderId, group.map((o) => o.sourceId))))
              .orderBy(asc(t.orderLines.orderId), asc(t.orderLines.position));
            for (const l of ls) {
              const k = `${l.source}\u0000${l.orderId}`;
              lines.set(k, [...(lines.get(k) ?? []), { lineId: l.lineId, productId: l.productId, locationId: l.locationId, quantity: l.quantity, unitPrice: l.unitPrice }]);
            }
          }
        }
        return rows.map(
          (r): OrderRow => ({
            ...r,
            orderedAt: isoOrNull(r.orderedAt),
            deliveredAt: isoOrNull(r.deliveredAt),
            sourceUpdatedAt: isoOrNull(r.sourceUpdatedAt),
            syncedAt: isoOf(r.syncedAt),
            deletedAt: isoOrNull(r.deletedAt),
            lines: lines.get(`${r.source}\u0000${r.sourceId}`) ?? [],
          }),
        ) as EntityRowMap[K][];
      }
    }
    return [];
  }

  async liveIds(kind: EntityKind, source: string): Promise<string[]> {
    const table = this.#table(kind);
    const rows = await this.db.select({ id: table.sourceId }).from(table).where(and(eq(table.source, source), isNull(table.deletedAt)));
    return rows.map((r) => r.id);
  }

  // ── inventory ──────────────────────────────────────────────────────────────────────────────

  async saveInventorySnapshot(snapshot: InventorySnapshot): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const c of chunks(snapshot.rows)) {
        await tx
          .insert(t.inventorySnapshots)
          .values(c.map((r) => ({ source: snapshot.source, snapshotAt: snapshot.snapshotAt, ...r })))
          .onConflictDoNothing();
      }
      // The latest snapshot time is tracked as a cursor row so an empty snapshot is still "latest".
      const marker = { source: snapshot.source, stream: INVENTORY_STREAM, cursorAt: snapshot.snapshotAt, lastFullAt: snapshot.snapshotAt, lastRunAt: snapshot.snapshotAt, lastStats: null };
      await tx.insert(t.syncCursors).values(marker).onConflictDoUpdate({ target: [t.syncCursors.source, t.syncCursors.stream], set: excludedSet(t.syncCursors, ['source', 'stream']) });
    });
  }

  async patchInventory(source: string, at: string, productIds: readonly string[], rows: InventorySnapshot['rows']): Promise<void> {
    const latest = await this.latestInventory(source);
    const kept = (latest?.rows ?? []).filter((r) => !productIds.includes(r.productId));
    await this.saveInventorySnapshot({ source, snapshotAt: at, rows: [...kept, ...rows] });
  }

  async latestInventory(source: string): Promise<InventorySnapshot | null> {
    const [marker] = await this.db.select().from(t.syncCursors).where(and(eq(t.syncCursors.source, source), eq(t.syncCursors.stream, INVENTORY_STREAM)));
    if (!marker) return null;
    const rows = await this.db
      .select()
      .from(t.inventorySnapshots)
      .where(and(eq(t.inventorySnapshots.source, source), eq(t.inventorySnapshots.snapshotAt, marker.cursorAt)));
    return {
      source,
      snapshotAt: isoOf(marker.cursorAt),
      rows: rows.map((r) => ({ productId: r.productId, locationId: r.locationId, active: r.active, reserved: r.reserved, available: r.available })),
    };
  }

  // ── facts ──────────────────────────────────────────────────────────────────────────────────

  async appendFacts(facts: readonly Fact[]): Promise<number> {
    let n = 0;
    for (const c of chunks(facts)) {
      // de-duplicate within the batch (ON CONFLICT cannot touch the same row twice)
      const uniqueRows = [...new Map(c.map((f) => [[f.source, f.entityType, f.entityKey, f.metric, f.observedAt].join('\u0000'), f])).values()];
      await this.db
        .insert(t.facts)
        .values(uniqueRows)
        .onConflictDoUpdate({
          target: [t.facts.source, t.facts.entityType, t.facts.entityKey, t.facts.metric, t.facts.observedAt],
          set: { value: sql.raw('excluded."value"'), ingestedAt: sql`now()` },
        });
      n += uniqueRows.length;
    }
    return n;
  }

  async listFacts(q: FactQuery = {}): Promise<Fact[]> {
    const conds: SQL[] = [];
    if (q.source) conds.push(eq(t.facts.source, q.source));
    if (q.entityType) conds.push(eq(t.facts.entityType, q.entityType));
    if (q.entityKeys) conds.push(q.entityKeys.length ? inArray(t.facts.entityKey, [...q.entityKeys]) : sql`false`);
    if (q.metrics) conds.push(q.metrics.length ? inArray(t.facts.metric, [...q.metrics]) : sql`false`);
    if (q.since) conds.push(gte(t.facts.observedAt, q.since));
    const rows = await this.db.select().from(t.facts).where(and(...conds)).orderBy(asc(t.facts.observedAt));
    return rows.map((r) => ({ source: r.source, entityType: r.entityType, entityKey: r.entityKey, metric: r.metric, value: r.value, observedAt: isoOf(r.observedAt) }));
  }

  // ── sync bookkeeping ───────────────────────────────────────────────────────────────────────

  #cursor(r: typeof t.syncCursors.$inferSelect): SyncCursor {
    return { source: r.source, stream: r.stream, cursorAt: isoOf(r.cursorAt), lastFullAt: isoOf(r.lastFullAt), lastRunAt: isoOf(r.lastRunAt), lastStats: r.lastStats ?? null };
  }

  async getCursor(source: string, stream: string): Promise<SyncCursor | null> {
    const [r] = await this.db.select().from(t.syncCursors).where(and(eq(t.syncCursors.source, source), eq(t.syncCursors.stream, stream)));
    return r ? this.#cursor(r) : null;
  }

  async putCursor(cursor: SyncCursor): Promise<void> {
    await this.db.insert(t.syncCursors).values(cursor).onConflictDoUpdate({ target: [t.syncCursors.source, t.syncCursors.stream], set: excludedSet(t.syncCursors, ['source', 'stream']) });
  }

  async listCursors(source?: string): Promise<SyncCursor[]> {
    const rows = await this.db.select().from(t.syncCursors).where(source ? eq(t.syncCursors.source, source) : undefined);
    return rows.filter((r) => r.stream !== INVENTORY_STREAM).map((r) => this.#cursor(r));
  }

  async appendSyncRun(run: SyncRun): Promise<void> {
    await this.db.insert(t.syncRuns).values(run).onConflictDoNothing();
  }

  async listSyncRuns(limit = 50): Promise<SyncRun[]> {
    const rows = await this.db.select().from(t.syncRuns).orderBy(desc(t.syncRuns.startedAt)).limit(limit);
    return rows.map((r) => ({ ...r, startedAt: isoOf(r.startedAt), finishedAt: isoOf(r.finishedAt) }));
  }

  async hasWebhookEvent(k: WebhookEventKey): Promise<boolean> {
    const rows = await this.db
      .select({ id: t.webhookEvents.recordId })
      .from(t.webhookEvents)
      .where(and(eq(t.webhookEvents.source, k.source), eq(t.webhookEvents.type, k.type), eq(t.webhookEvents.recordId, k.recordId), eq(t.webhookEvents.occurredAt, k.occurredAt)));
    return rows.length > 0;
  }

  async recordWebhookEvent(k: WebhookEventKey, receivedAt: string): Promise<boolean> {
    const rows = await this.db
      .insert(t.webhookEvents)
      .values({ ...k, receivedAt })
      .onConflictDoNothing()
      .returning({ id: t.webhookEvents.recordId });
    return rows.length > 0;
  }

  // ── memories ───────────────────────────────────────────────────────────────────────────────

  async appendSignals(signals: readonly HarnessSignal[]): Promise<HarnessSignal[]> {
    if (!signals.length) return [];
    const fresh = new Set<string>();
    for (const c of chunks(signals)) {
      const rows = await this.db
        .insert(t.harnessSignals)
        .values(c.map((s) => ({ id: s.id, kind: s.kind, at: s.at, proposalId: 'proposalId' in s ? s.proposalId : null, payload: s })))
        .onConflictDoNothing()
        .returning({ id: t.harnessSignals.id });
      for (const r of rows) fresh.add(r.id);
    }
    return signals.filter((s) => fresh.has(s.id));
  }

  async listSignals(since?: string): Promise<HarnessSignal[]> {
    const rows = await this.db
      .select({ payload: t.harnessSignals.payload })
      .from(t.harnessSignals)
      .where(since ? gte(t.harnessSignals.at, since) : undefined)
      .orderBy(asc(t.harnessSignals.at));
    return rows.map((r) => r.payload);
  }

  #memory(r: typeof t.memories.$inferSelect): Memory {
    return { ...r, createdAt: isoOf(r.createdAt), lastConfirmedAt: isoOf(r.lastConfirmedAt), expiresAt: isoOrNull(r.expiresAt) };
  }

  async getMemory(id: string): Promise<Memory | null> {
    const [r] = await this.db.select().from(t.memories).where(eq(t.memories.id, id));
    return r ? this.#memory(r) : null;
  }

  async putMemory(memory: Memory): Promise<void> {
    await this.db.insert(t.memories).values(memory).onConflictDoUpdate({ target: t.memories.id, set: excludedSet(t.memories, ['id']) });
  }

  async listMemories(q: MemoryQuery = {}): Promise<Memory[]> {
    const conds: SQL[] = [];
    if (q.scope) conds.push(eq(t.memories.scope, q.scope));
    if (q.scopeIds) conds.push(q.scopeIds.length ? inArray(t.memories.scopeId, [...q.scopeIds]) : sql`false`);
    if (q.statuses) conds.push(q.statuses.length ? inArray(t.memories.status, [...q.statuses]) : sql`false`);
    const rows = await this.db.select().from(t.memories).where(and(...conds));
    return rows.map((r) => this.#memory(r));
  }

  // ── profiles ───────────────────────────────────────────────────────────────────────────────

  async saveProfile(snapshot: Omit<ProfileSnapshot, 'version'>): Promise<ProfileSnapshot> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('context.profile_snapshots'))`);
      const [{ v } = { v: null }] = await tx.select({ v: max(t.profileSnapshots.version) }).from(t.profileSnapshots);
      const version = (v ?? 0) + 1;
      const { id, computedAt, source, ...profile } = snapshot;
      await tx.insert(t.profileSnapshots).values({ id, version, computedAt, source, profile });
      return { ...snapshot, version };
    });
  }

  async latestProfile(): Promise<ProfileSnapshot | null> {
    const [r] = await this.db.select().from(t.profileSnapshots).orderBy(desc(t.profileSnapshots.version)).limit(1);
    return r ? { ...r.profile, id: r.id, version: r.version, computedAt: isoOf(r.computedAt), source: r.source } : null;
  }
}

function groupBySource<T extends { source: string }>(rows: readonly T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(r.source, [...(m.get(r.source) ?? []), r]);
  return m;
}
