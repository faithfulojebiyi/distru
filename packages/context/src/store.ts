/**
 * The `ContextStore` port: everything the context layer persists. Two adapters ship:
 * `InMemoryContextStore` (tests, evals, demos) and `DrizzleContextStore` (`@ops/context/drizzle`,
 * Postgres schema `context`).
 */
import type {
  EntityKind,
  EntityRowMap,
  Fact,
  HarnessSignal,
  InventorySnapshot,
  Memory,
  MemoryScope,
  ProfileSnapshot,
  SyncCursor,
  SyncRun,
  WebhookEventKey,
} from './model';

export interface EntityQuery {
  source?: string;
  ids?: readonly string[];
  /** vendor (purchase, product) or customer (order) source ids. */
  partyIds?: readonly string[];
  /** Inclusive `orderedAt` range (purchases, orders). */
  from?: string;
  to?: string;
  statuses?: readonly string[];
  includeDeleted?: boolean;
}

export interface FactQuery {
  source?: string;
  entityType?: string;
  entityKeys?: readonly string[];
  metrics?: readonly string[];
  since?: string;
}

export interface MemoryQuery {
  scope?: MemoryScope;
  scopeIds?: readonly string[];
  statuses?: readonly Memory['status'][];
}

export interface ContextStore {
  // unified layer
  /** Insert or replace by (source, sourceId). Purchases/orders replace their lines. */
  upsert<K extends EntityKind>(kind: K, rows: readonly EntityRowMap[K][]): Promise<void>;
  /** Soft-deletes; returns how many live rows were marked. */
  markDeleted(kind: EntityKind, source: string, sourceIds: readonly string[], at: string): Promise<number>;
  list<K extends EntityKind>(kind: K, query?: EntityQuery): Promise<EntityRowMap[K][]>;
  /** Live (not deleted) source ids of a kind, for full reconciles. */
  liveIds(kind: EntityKind, source: string): Promise<string[]>;

  saveInventorySnapshot(snapshot: InventorySnapshot): Promise<void>;
  /** Replaces the rows of the given products in the latest snapshot (webhook partial refresh). */
  patchInventory(source: string, at: string, productIds: readonly string[], rows: InventorySnapshot['rows']): Promise<void>;
  latestInventory(source: string): Promise<InventorySnapshot | null>;

  /** Upsert on (source, entityType, entityKey, metric, observedAt); returns rows written. */
  appendFacts(facts: readonly Fact[]): Promise<number>;
  listFacts(query?: FactQuery): Promise<Fact[]>;

  // sync bookkeeping
  getCursor(source: string, stream: string): Promise<SyncCursor | null>;
  putCursor(cursor: SyncCursor): Promise<void>;
  listCursors(source?: string): Promise<SyncCursor[]>;
  appendSyncRun(run: SyncRun): Promise<void>;
  listSyncRuns(limit?: number): Promise<SyncRun[]>;
  hasWebhookEvent(key: WebhookEventKey): Promise<boolean>;
  /** Records a processed webhook event; false when it was already recorded. */
  recordWebhookEvent(key: WebhookEventKey, receivedAt: string): Promise<boolean>;

  // memories
  /** Stores signals not seen before (by id) and returns only the new ones. */
  appendSignals(signals: readonly HarnessSignal[]): Promise<HarnessSignal[]>;
  listSignals(since?: string): Promise<HarnessSignal[]>;
  getMemory(id: string): Promise<Memory | null>;
  putMemory(memory: Memory): Promise<void>;
  listMemories(query?: MemoryQuery): Promise<Memory[]>;

  // profiles
  /** Persists a snapshot with the next version number and returns it. */
  saveProfile(snapshot: Omit<ProfileSnapshot, 'version'>): Promise<ProfileSnapshot>;
  latestProfile(): Promise<ProfileSnapshot | null>;
}

// ── shared filtering (also used by the Drizzle adapter's tests for parity) ─────────────────────

type AnyRow = EntityRowMap[EntityKind];

export function partyOf(kind: EntityKind, row: AnyRow): string | null {
  if (kind === 'purchase' || kind === 'product') return (row as EntityRowMap['purchase' | 'product']).vendorId;
  if (kind === 'order') return (row as EntityRowMap['order']).customerId;
  return null;
}

export function orderedAtOf(row: AnyRow): string | null {
  return 'orderedAt' in row ? row.orderedAt : null;
}

export function matchesEntityQuery(kind: EntityKind, row: AnyRow, q: EntityQuery): boolean {
  if (!q.includeDeleted && row.deletedAt) return false;
  if (q.source && row.source !== q.source) return false;
  if (q.ids && !q.ids.includes(row.sourceId)) return false;
  if (q.partyIds) {
    const party = partyOf(kind, row);
    if (!party || !q.partyIds.includes(party)) return false;
  }
  if (q.statuses) {
    if (!('status' in row) || !q.statuses.includes(row.status)) return false;
  }
  if (q.from || q.to) {
    const at = orderedAtOf(row);
    if (!at) return false;
    const t = Date.parse(at);
    if (q.from && t < Date.parse(q.from)) return false;
    if (q.to && t > Date.parse(q.to)) return false;
  }
  return true;
}

const key2 = (a: string, b: string) => `${a}\u0000${b}`;
const clone = <T>(v: T): T => structuredClone(v);

/** In-memory adapter. Values are cloned in and out, like a database. */
export class InMemoryContextStore implements ContextStore {
  readonly #entities: { [K in EntityKind]: Map<string, EntityRowMap[K]> } = {
    product: new Map(),
    company: new Map(),
    purchase: new Map(),
    order: new Map(),
  };
  readonly #inventory = new Map<string, InventorySnapshot[]>();
  readonly #facts = new Map<string, Fact>();
  readonly #cursors = new Map<string, SyncCursor>();
  readonly #runs: SyncRun[] = [];
  readonly #webhooks = new Set<string>();
  readonly #signals = new Map<string, HarnessSignal>();
  readonly #memories = new Map<string, Memory>();
  readonly #profiles: ProfileSnapshot[] = [];

  async upsert<K extends EntityKind>(kind: K, rows: readonly EntityRowMap[K][]): Promise<void> {
    const table = this.#entities[kind] as Map<string, EntityRowMap[K]>;
    for (const row of rows) table.set(key2(row.source, row.sourceId), clone(row));
  }

  async markDeleted(kind: EntityKind, source: string, sourceIds: readonly string[], at: string): Promise<number> {
    const table = this.#entities[kind] as Map<string, AnyRow>;
    let n = 0;
    for (const id of sourceIds) {
      const row = table.get(key2(source, id));
      if (row && !row.deletedAt) {
        table.set(key2(source, id), { ...row, deletedAt: at });
        n++;
      }
    }
    return n;
  }

  async list<K extends EntityKind>(kind: K, query: EntityQuery = {}): Promise<EntityRowMap[K][]> {
    const table = this.#entities[kind] as Map<string, EntityRowMap[K]>;
    return [...table.values()].filter((r) => matchesEntityQuery(kind, r, query)).map(clone);
  }

  async liveIds(kind: EntityKind, source: string): Promise<string[]> {
    const table = this.#entities[kind] as Map<string, AnyRow>;
    return [...table.values()].filter((r) => r.source === source && !r.deletedAt).map((r) => r.sourceId);
  }

  async saveInventorySnapshot(snapshot: InventorySnapshot): Promise<void> {
    const list = this.#inventory.get(snapshot.source) ?? [];
    list.push(clone(snapshot));
    list.sort((a, b) => (a.snapshotAt < b.snapshotAt ? -1 : 1));
    this.#inventory.set(snapshot.source, list);
  }

  async patchInventory(source: string, at: string, productIds: readonly string[], rows: InventorySnapshot['rows']): Promise<void> {
    const latest = await this.latestInventory(source);
    const kept = (latest?.rows ?? []).filter((r) => !productIds.includes(r.productId));
    await this.saveInventorySnapshot({ source, snapshotAt: at, rows: [...kept, ...rows] });
  }

  async latestInventory(source: string): Promise<InventorySnapshot | null> {
    const list = this.#inventory.get(source);
    const last = list?.[list.length - 1];
    return last ? clone(last) : null;
  }

  async appendFacts(facts: readonly Fact[]): Promise<number> {
    for (const f of facts) this.#facts.set([f.source, f.entityType, f.entityKey, f.metric, f.observedAt].join('\u0000'), clone(f));
    return facts.length;
  }

  async listFacts(q: FactQuery = {}): Promise<Fact[]> {
    return [...this.#facts.values()]
      .filter(
        (f) =>
          (!q.source || f.source === q.source) &&
          (!q.entityType || f.entityType === q.entityType) &&
          (!q.entityKeys || q.entityKeys.includes(f.entityKey)) &&
          (!q.metrics || q.metrics.includes(f.metric)) &&
          (!q.since || f.observedAt >= q.since),
      )
      .sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0))
      .map(clone);
  }

  async getCursor(source: string, stream: string): Promise<SyncCursor | null> {
    const c = this.#cursors.get(key2(source, stream));
    return c ? clone(c) : null;
  }

  async putCursor(cursor: SyncCursor): Promise<void> {
    this.#cursors.set(key2(cursor.source, cursor.stream), clone(cursor));
  }

  async listCursors(source?: string): Promise<SyncCursor[]> {
    return [...this.#cursors.values()].filter((c) => !source || c.source === source).map(clone);
  }

  async appendSyncRun(run: SyncRun): Promise<void> {
    this.#runs.push(clone(run));
  }

  async listSyncRuns(limit = 50): Promise<SyncRun[]> {
    return this.#runs.slice(-limit).reverse().map(clone);
  }

  #webhookKey(k: WebhookEventKey): string {
    return [k.source, k.type, k.recordId, k.occurredAt].join('\u0000');
  }

  async hasWebhookEvent(key: WebhookEventKey): Promise<boolean> {
    return this.#webhooks.has(this.#webhookKey(key));
  }

  async recordWebhookEvent(key: WebhookEventKey): Promise<boolean> {
    const k = this.#webhookKey(key);
    if (this.#webhooks.has(k)) return false;
    this.#webhooks.add(k);
    return true;
  }

  async appendSignals(signals: readonly HarnessSignal[]): Promise<HarnessSignal[]> {
    const fresh: HarnessSignal[] = [];
    for (const s of signals) {
      if (this.#signals.has(s.id)) continue;
      this.#signals.set(s.id, clone(s));
      fresh.push(clone(s));
    }
    return fresh;
  }

  async listSignals(since?: string): Promise<HarnessSignal[]> {
    return [...this.#signals.values()].filter((s) => !since || s.at >= since).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).map(clone);
  }

  async getMemory(id: string): Promise<Memory | null> {
    const m = this.#memories.get(id);
    return m ? clone(m) : null;
  }

  async putMemory(memory: Memory): Promise<void> {
    this.#memories.set(memory.id, clone(memory));
  }

  async listMemories(q: MemoryQuery = {}): Promise<Memory[]> {
    return [...this.#memories.values()]
      .filter((m) => (!q.scope || m.scope === q.scope) && (!q.scopeIds || (m.scopeId !== null && q.scopeIds.includes(m.scopeId))) && (!q.statuses || q.statuses.includes(m.status)))
      .map(clone);
  }

  async saveProfile(snapshot: Omit<ProfileSnapshot, 'version'>): Promise<ProfileSnapshot> {
    const version = (this.#profiles[this.#profiles.length - 1]?.version ?? 0) + 1;
    const saved: ProfileSnapshot = { ...clone(snapshot), version };
    this.#profiles.push(saved);
    return clone(saved);
  }

  async latestProfile(): Promise<ProfileSnapshot | null> {
    const last = this.#profiles[this.#profiles.length - 1];
    return last ? clone(last) : null;
  }
}
