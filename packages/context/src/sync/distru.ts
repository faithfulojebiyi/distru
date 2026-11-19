/**
 * Distru → unified layer, following Distru's documented incremental-sync recipe exactly:
 *
 * 1. **Full load once** per record type (no filters). Its start time is the `Date` header of the first
 *    response (via `DistruObserver`), else the injected clock. A full load costs list budget (one
 *    call per page: 3,000 per account, refilling 5/min), so it is the only rate-budgeted run.
 * 2. **Each run**: `updated_datetime=<previous start − 5 min>,` and no other filters, upsert by id.
 *    With a run at least every 30 days the lower bound is always inside the free window, so every
 *    list call is free and never refused. (Purchases pass every status explicitly: Distru hides
 *    DRAFT unless asked; that is not a narrowing filter.)
 * 3. **Deletes**: `/deleted-records?record_type=X&deleted_datetime=<same lower bound>,` per record
 *    type in the same run (Distru keeps them 90 days).
 * 4. **Cursor advances only on success** of the whole stream (list pages + deleted records).
 * 5. **Weekly reconcile**: a full load that also soft-deletes rows the source no longer returns.
 * 6. **Stock from /inventory** (unlimited): product quantities don't move `updated_datetime`, so
 *    each run stores an inventory snapshot grouped by product + location.
 *
 * Webhooks (PRODUCT / PURCHASE / ORDER / COMPANY) trigger `syncRecord(type, id, occurredAt)`:
 * get-by-id (unlimited), deduped on (type, id, occurred_datetime); 404 → soft delete.
 */
import { z } from 'zod';
import {
  DistruApiError,
  ListDeletedRecordsRecordType,
  ListInventoryGroupingsItem,
  ListPurchasesStatusesItem,
  type DistruClient,
  type Page,
} from '@ops/distru-client';
import type { EntityKind, InventoryRow, PurchaseRow, StreamStats, SyncCursor, SyncRun, SyncStream } from '../model';
import type { ContextStore } from '../store';
import { DAY_MS, iso, MINUTE_MS, systemClock, type ContextClock } from '../util';
import {
  DISTRU_SOURCE,
  DistruDeletedIn,
  normalizeCompany,
  normalizeInventory,
  normalizeOrder,
  normalizeProduct,
  normalizePurchase,
} from './normalize';
import type { DistruObserver } from './rate';

export const DISTRU_STREAMS: readonly SyncStream[] = ['companies', 'products', 'purchases', 'orders'];

const STREAM_KIND: Record<SyncStream, EntityKind> = { companies: 'company', products: 'product', purchases: 'purchase', orders: 'order' };
const STREAM_DELETED_TYPE: Record<SyncStream, ListDeletedRecordsRecordType> = {
  companies: ListDeletedRecordsRecordType.COMPANY,
  products: ListDeletedRecordsRecordType.PRODUCT,
  purchases: ListDeletedRecordsRecordType.PURCHASE,
  orders: ListDeletedRecordsRecordType.ORDER,
};
const ALL_PURCHASE_STATUSES = Object.values(ListPurchasesStatusesItem);

/** Raised before a paid list call when the account's list budget is below the reserve. */
export class RateBudgetError extends Error {
  override readonly name = 'RateBudgetError';
  constructor(
    readonly remaining: number,
    readonly retryAfterMs: number,
  ) {
    super(`Distru list budget low (${remaining} left); deferring paid list calls for ~${Math.ceil(retryAfterMs / 1000)}s`);
  }
}

export interface DistruSyncOptions {
  client: DistruClient;
  store: ContextStore;
  clock?: ContextClock;
  /** Reads `Date` and `X-RateLimit-*` headers; the client must be built with `fetch: observer.wrap(fetch)`. */
  observer?: DistruObserver;
  /** Overlap subtracted from the previous start. Default 5 minutes (Distru's recipe). */
  overlapMs?: number;
  /** Distru's free window for `updated_datetime` lower bounds. Default 30 days. */
  freeWindowDays?: number;
  /** Full reconcile cadence per stream; null disables. Default 7 days. */
  reconcileEveryMs?: number | null;
  /** Keep at least this much list budget before a paid call. Default 100. */
  minRateRemaining?: number;
  /** Bucket refill rate used to estimate a backoff. Default 5/min. */
  refillPerMinute?: number;
  /** Longest backoff a run will sleep through before deferring. Default 60 s. */
  maxBackoffMs?: number;
  streams?: readonly SyncStream[];
  /** Snapshot /inventory each run. Default true. */
  inventory?: boolean;
  ids?: () => string;
}

export interface StreamResult {
  status: 'ok' | 'failed' | 'deferred' | 'skipped';
  stats: StreamStats | null;
  cursorAt: string | null;
  error: string | null;
}

export interface SyncRunResult {
  id: string;
  kind: SyncRun['kind'];
  status: SyncRun['status'];
  startedAt: string;
  finishedAt: string;
  streams: Partial<Record<SyncStream, StreamResult>>;
  inventory: { rows: number; snapshotAt: string } | null;
  rateLimit: { remaining: number | null; limit: number | null };
  retryAfterMs: number | null;
  error: string | null;
}

export type WebhookRecordType = 'PRODUCT' | 'PURCHASE' | 'ORDER' | 'COMPANY';

export interface SyncRecordResult {
  status: 'upserted' | 'deleted' | 'duplicate' | 'ignored';
  type: string;
  id: string;
}

/** Distru webhook body: `{ type, event, id, object, changes, occurred_datetime }`. `object` is not trusted (captured at change time). */
export const DistruWebhookSchema = z.object({
  type: z.string(),
  event: z.string().optional(),
  id: z.union([z.string(), z.number()]).transform(String),
  occurred_datetime: z.string(),
});

const DataEnvelope = z.object({ data: z.unknown() });

class StreamFailure extends Error {
  constructor(
    readonly cause: unknown,
    readonly stats: StreamStats,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

export function createDistruSync(options: DistruSyncOptions) {
  const { client, store, observer } = options;
  const clock = options.clock ?? systemClock;
  const overlapMs = options.overlapMs ?? 5 * MINUTE_MS;
  const freeWindowMs = (options.freeWindowDays ?? 30) * DAY_MS;
  const reconcileEveryMs = options.reconcileEveryMs === undefined ? 7 * DAY_MS : options.reconcileEveryMs;
  const minRemaining = options.minRateRemaining ?? 100;
  const refillPerMinute = options.refillPerMinute ?? 5;
  const maxBackoffMs = options.maxBackoffMs ?? 60_000;
  const streams = options.streams ?? DISTRU_STREAMS;
  const ids = options.ids ?? (() => crypto.randomUUID());
  const nowIso = () => iso(clock.now());

  const isFree = (lowerBound: string | null) => lowerBound !== null && clock.now().getTime() - Date.parse(lowerBound) <= freeWindowMs;

  /** Before a paid call: back off (bounded) or defer when the observed budget is below the reserve. */
  async function budgetGate(paid: boolean): Promise<void> {
    if (!paid) return;
    const remaining = observer?.rateLimit.remaining;
    if (remaining === null || remaining === undefined || remaining >= minRemaining) return;
    const waitMs = Math.ceil(((minRemaining - remaining) / refillPerMinute) * MINUTE_MS);
    if (waitMs <= maxBackoffMs && clock.sleep) {
      await clock.sleep(waitMs);
      return;
    }
    throw new RateBudgetError(remaining, waitMs);
  }

  function pagesFor(stream: SyncStream, lowerBound: string | null): AsyncGenerator<Page<unknown>> {
    const u = lowerBound ? { updated_datetime: `${lowerBound},` } : {};
    switch (stream) {
      case 'companies':
        return client.pages(client.listCompanies, u);
      case 'products':
        return client.pages(client.listProducts, u);
      case 'purchases':
        return client.pages(client.listPurchases, { ...u, statuses: [...ALL_PURCHASE_STATUSES] });
      case 'orders':
        return client.pages(client.listOrders, u);
    }
  }

  async function upsertRaw(stream: SyncStream, raws: unknown[], syncedAt: string): Promise<string[]> {
    switch (stream) {
      case 'companies': {
        const rows = raws.map((r) => normalizeCompany(r, syncedAt));
        await store.upsert('company', rows);
        return rows.map((r) => r.sourceId);
      }
      case 'products': {
        const rows = raws.map((r) => normalizeProduct(r, syncedAt));
        await store.upsert('product', rows);
        return rows.map((r) => r.sourceId);
      }
      case 'purchases': {
        const idsOf = raws.map((r) => z.object({ id: z.string() }).parse(r).id);
        const prev = new Map<string, PurchaseRow>((await store.list('purchase', { source: DISTRU_SOURCE, ids: idsOf, includeDeleted: true })).map((p) => [p.sourceId, p]));
        const rows = raws.map((r, i) => normalizePurchase(r, syncedAt, prev.get(idsOf[i]!) ?? null));
        await store.upsert('purchase', rows);
        return rows.map((r) => r.sourceId);
      }
      case 'orders': {
        const rows = raws.map((r) => normalizeOrder(r, syncedAt));
        await store.upsert('order', rows);
        return rows.map((r) => r.sourceId);
      }
    }
  }

  async function syncStream(stream: SyncStream, forced: 'full' | 'reconcile' | null): Promise<{ stats: StreamStats; cursorAt: string }> {
    const prev = await store.getCursor(DISTRU_SOURCE, stream);
    const nowMs = clock.now().getTime();
    let mode: StreamStats['mode'];
    if (!prev) mode = 'full';
    else if (forced) mode = 'reconcile';
    else if (reconcileEveryMs !== null && nowMs - Date.parse(prev.lastFullAt) >= reconcileEveryMs) mode = 'reconcile';
    else mode = 'incremental';
    const lowerBound = mode === 'incremental' && prev ? iso(Date.parse(prev.cursorAt) - overlapMs) : null;
    const paid = !isFree(lowerBound);
    const stats: StreamStats = { mode, lowerBound, pages: 0, paidPages: 0, fetched: 0, deleted: 0 };

    observer?.mark();
    const clockStart = clock.now();
    const seen = new Set<string>();
    try {
      await budgetGate(paid);
      for await (const page of pagesFor(stream, lowerBound)) {
        stats.pages++;
        if (paid) stats.paidPages++;
        const data = page.data ?? [];
        for (const id of await upsertRaw(stream, data, nowIso())) seen.add(id);
        stats.fetched += data.length;
        if (page.next_page) await budgetGate(paid);
      }
      const startedAt = observer?.firstDateSinceMark() ?? clockStart;

      if (mode === 'incremental' && lowerBound) {
        const deletedIds: string[] = [];
        let lastDeletedAt = nowIso();
        for await (const page of client.pages(client.listDeletedRecords, { record_type: STREAM_DELETED_TYPE[stream], deleted_datetime: `${lowerBound},` })) {
          for (const raw of page.data ?? []) {
            const d = DistruDeletedIn.parse(raw);
            deletedIds.push(d.record_id);
            lastDeletedAt = d.deleted_datetime;
          }
        }
        stats.deleted = await store.markDeleted(STREAM_KIND[stream], DISTRU_SOURCE, deletedIds, lastDeletedAt);
      } else if (prev) {
        // Reconcile: anything we hold that the full listing no longer returns is gone.
        const missing = (await store.liveIds(STREAM_KIND[stream], DISTRU_SOURCE)).filter((id) => !seen.has(id));
        stats.deleted = await store.markDeleted(STREAM_KIND[stream], DISTRU_SOURCE, missing, nowIso());
      }

      const cursorAt = iso(startedAt);
      const cursor: SyncCursor = {
        source: DISTRU_SOURCE,
        stream,
        cursorAt,
        lastFullAt: mode === 'incremental' && prev ? prev.lastFullAt : cursorAt,
        lastRunAt: nowIso(),
        lastStats: stats,
      };
      await store.putCursor(cursor);
      return { stats, cursorAt };
    } catch (err) {
      throw new StreamFailure(err, stats);
    }
  }

  async function snapshotInventory(): Promise<{ rows: number; snapshotAt: string }> {
    const snapshotAt = nowIso();
    const rows: InventoryRow[] = [];
    for await (const page of client.pages(client.listInventory, { groupings: [ListInventoryGroupingsItem.PRODUCT, ListInventoryGroupingsItem.LOCATION] })) {
      for (const raw of page.data ?? []) rows.push(normalizeInventory(raw));
    }
    await store.saveInventorySnapshot({ source: DISTRU_SOURCE, snapshotAt, rows });
    return { rows: rows.length, snapshotAt };
  }

  /**
   * One sync run over all streams (+ inventory). `mode: 'reconcile'` forces a full reconcile of
   * streams that already have a cursor. Stops at the first failing stream; streams that finished keep
   * their advanced cursors, the failing one keeps its old cursor.
   */
  async function run(opts: { mode?: 'auto' | 'reconcile' } = {}): Promise<SyncRunResult> {
    const id = ids();
    const startedAt = nowIso();
    const results: Partial<Record<SyncStream, StreamResult>> = {};
    let status: SyncRun['status'] = 'ok';
    let error: string | null = null;
    let retryAfterMs: number | null = null;
    for (const stream of streams) {
      if (status !== 'ok') {
        results[stream] = { status: 'skipped', stats: null, cursorAt: null, error: null };
        continue;
      }
      try {
        const { stats, cursorAt } = await syncStream(stream, opts.mode === 'reconcile' ? 'reconcile' : null);
        results[stream] = { status: 'ok', stats, cursorAt, error: null };
      } catch (e) {
        const failure = e instanceof StreamFailure ? e : new StreamFailure(e, { mode: 'incremental', lowerBound: null, pages: 0, paidPages: 0, fetched: 0, deleted: 0 });
        const cause = failure.cause;
        const rateLimited = cause instanceof RateBudgetError || (cause instanceof DistruApiError && cause.isRateLimited);
        status = rateLimited ? 'deferred' : 'failed';
        error = `${stream}: ${failure.message}`;
        if (cause instanceof RateBudgetError) retryAfterMs = cause.retryAfterMs;
        else if (cause instanceof DistruApiError && cause.retryAfterSeconds !== undefined) retryAfterMs = cause.retryAfterSeconds * 1000;
        results[stream] = { status: rateLimited ? 'deferred' : 'failed', stats: failure.stats, cursorAt: null, error: failure.message };
      }
    }
    let inventory: SyncRunResult['inventory'] = null;
    if (status === 'ok' && options.inventory !== false) {
      try {
        inventory = await snapshotInventory();
      } catch (e) {
        status = 'failed';
        error = `inventory: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    const result: SyncRunResult = {
      id,
      kind: opts.mode === 'reconcile' ? 'reconcile' : 'auto',
      status,
      startedAt,
      finishedAt: nowIso(),
      streams: results,
      inventory,
      rateLimit: { remaining: observer?.rateLimit.remaining ?? null, limit: observer?.rateLimit.limit ?? null },
      retryAfterMs,
      error,
    };
    await store.appendSyncRun({
      id,
      source: DISTRU_SOURCE,
      kind: result.kind,
      status,
      startedAt,
      finishedAt: result.finishedAt,
      stats: { streams: results, inventory, rateLimit: result.rateLimit },
      error,
    });
    return result;
  }

  async function refreshInventoryFor(productIds: string[]): Promise<void> {
    if (!productIds.length) return;
    const rows: InventoryRow[] = [];
    for await (const page of client.pages(client.listInventory, { groupings: [ListInventoryGroupingsItem.PRODUCT, ListInventoryGroupingsItem.LOCATION], product_ids: productIds })) {
      for (const raw of page.data ?? []) rows.push(normalizeInventory(raw));
    }
    await store.patchInventory(DISTRU_SOURCE, nowIso(), productIds, rows);
  }

  async function fetchById(type: WebhookRecordType, id: string): Promise<unknown | null> {
    try {
      const res =
        type === 'PRODUCT'
          ? await client.getProduct(id)
          : type === 'PURCHASE'
            ? await client.getPurchase(id)
            : type === 'ORDER'
              ? await client.getOrder(id)
              : await client.getCompany(id);
      return DataEnvelope.parse(res).data;
    } catch (e) {
      if (e instanceof DistruApiError && e.isNotFound) return null;
      throw e;
    }
  }

  const WEBHOOK_STREAM: Record<WebhookRecordType, SyncStream> = { PRODUCT: 'products', PURCHASE: 'purchases', ORDER: 'orders', COMPANY: 'companies' };
  const isWebhookType = (t: string): t is WebhookRecordType => t in WEBHOOK_STREAM;

  /**
   * Webhook-triggered partial sync. Re-reads the record by id (unlimited) instead of trusting the
   * webhook's `object`. With `occurredAt`, deduped on (type, id, occurred_datetime): Distru retries
   * ~10 times over ~4 h and has no event id. PRODUCT (fires on quantity changes) and ORDER (moves
   * reserved stock) also refresh those products' inventory rows.
   */
  async function syncRecord(type: string, id: string, occurredAt?: string): Promise<SyncRecordResult> {
    const upper = type.toUpperCase();
    if (!isWebhookType(upper)) return { status: 'ignored', type, id };
    const key = occurredAt ? { source: DISTRU_SOURCE, type: upper, recordId: id, occurredAt } : null;
    if (key && (await store.hasWebhookEvent(key))) return { status: 'duplicate', type: upper, id };
    const startedAt = nowIso();
    const raw = await fetchById(upper, id);
    let status: SyncRecordResult['status'];
    if (raw === null) {
      await store.markDeleted(STREAM_KIND[WEBHOOK_STREAM[upper]], DISTRU_SOURCE, [id], startedAt);
      status = 'deleted';
    } else {
      await upsertRaw(WEBHOOK_STREAM[upper], [raw], startedAt);
      status = 'upserted';
      if (upper === 'PRODUCT') await refreshInventoryFor([id]);
      if (upper === 'ORDER') {
        const order = (await store.list('order', { source: DISTRU_SOURCE, ids: [id] }))[0];
        await refreshInventoryFor([...new Set((order?.lines ?? []).map((l) => l.productId).filter((p): p is string => !!p))]);
      }
    }
    if (key) await store.recordWebhookEvent(key, nowIso());
    await store.appendSyncRun({ id: ids(), source: DISTRU_SOURCE, kind: 'record', status: 'ok', startedAt, finishedAt: nowIso(), stats: { type: upper, id, result: status }, error: null });
    return { status, type: upper, id };
  }

  /** Parses a verified webhook body (HMAC checked by the caller on the raw body) and syncs the record. */
  async function handleWebhook(body: unknown): Promise<SyncRecordResult> {
    const w = DistruWebhookSchema.parse(body);
    return syncRecord(w.type, w.id, w.occurred_datetime);
  }

  /** Cursors + recent runs + last seen budget, for a "sync health" panel. */
  async function status() {
    return {
      cursors: await store.listCursors(DISTRU_SOURCE),
      runs: await store.listSyncRuns(20),
      rateLimit: observer ? { ...observer.rateLimit } : null,
    };
  }

  return { run, syncRecord, handleWebhook, status, snapshotInventory };
}

export type DistruSync = ReturnType<typeof createDistruSync>;
