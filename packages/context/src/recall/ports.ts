/**
 * Recall ports: the vector index (PgVector in the app, in-memory for tests/evals) and the ledger of
 * indexed documents + source cursors (Drizzle `context.recall_*` in the app, in-memory otherwise).
 */
import { cosine } from './embedder';
import type { RecallChunkMeta, RecallCursor, RecallDocRecord, RecallFilter, RecallMatch } from './model';

export interface RecallVectorRow {
  id: string;
  vector: number[];
  meta: RecallChunkMeta;
}

export interface RecallVectorIndex {
  /** Creates the index when missing (idempotent). */
  ensure(dimension: number): Promise<void>;
  /** Insert or replace by id. */
  upsert(rows: readonly RecallVectorRow[]): Promise<void>;
  /** Removes every chunk of these documents. */
  deleteDocs(docIds: readonly string[]): Promise<void>;
  /** Nearest chunks (cosine, best first) that match the filter. */
  query(input: { vector: number[]; topK: number; filter?: RecallFilter }): Promise<RecallMatch[]>;
  /** Drops every vector (reindex). */
  clear(): Promise<void>;
}

export interface RecallStore {
  getDocs(ids: readonly string[]): Promise<Map<string, RecallDocRecord>>;
  putDocs(records: readonly RecallDocRecord[]): Promise<void>;
  countDocs(): Promise<number>;
  clearDocs(): Promise<void>;
  getCursor(stream: string): Promise<RecallCursor | null>;
  putCursor(cursor: RecallCursor): Promise<void>;
  clearCursors(): Promise<void>;
}

/** `RecallFilter` as a predicate over chunk metadata (shared by the in-memory index and tests). */
export function matchesRecallFilter(meta: RecallChunkMeta, filter: RecallFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.vendorIds?.length && !filter.vendorIds.includes(meta.vendorId)) return false;
  if (filter.sources?.length && !filter.sources.includes(meta.source)) return false;
  if (filter.sinceTs !== undefined && meta.ts < filter.sinceTs) return false;
  return true;
}

export class InMemoryRecallVectorIndex implements RecallVectorIndex {
  readonly rows = new Map<string, RecallVectorRow>();
  dimension: number | null = null;

  async ensure(dimension: number): Promise<void> {
    if (this.dimension !== null && this.dimension !== dimension) throw new Error(`recall index has dimension ${this.dimension}, embedder has ${dimension}`);
    this.dimension = dimension;
  }

  async upsert(rows: readonly RecallVectorRow[]): Promise<void> {
    for (const r of rows) this.rows.set(r.id, { ...r, vector: [...r.vector], meta: { ...r.meta } });
  }

  async deleteDocs(docIds: readonly string[]): Promise<void> {
    const ids = new Set(docIds);
    for (const [id, r] of this.rows) if (ids.has(r.meta.docId)) this.rows.delete(id);
  }

  async query({ vector, topK, filter }: { vector: number[]; topK: number; filter?: RecallFilter }): Promise<RecallMatch[]> {
    return [...this.rows.values()]
      .filter((r) => matchesRecallFilter(r.meta, filter))
      .map((r) => ({ id: r.id, score: cosine(vector, r.vector), meta: { ...r.meta } }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, topK);
  }

  async clear(): Promise<void> {
    this.rows.clear();
  }
}

export class InMemoryRecallStore implements RecallStore {
  readonly docs = new Map<string, RecallDocRecord>();
  readonly cursors = new Map<string, RecallCursor>();

  async getDocs(ids: readonly string[]): Promise<Map<string, RecallDocRecord>> {
    return new Map(ids.flatMap((id) => (this.docs.has(id) ? [[id, { ...this.docs.get(id)! }] as const] : [])));
  }

  async putDocs(records: readonly RecallDocRecord[]): Promise<void> {
    for (const r of records) this.docs.set(r.id, { ...r });
  }

  async countDocs(): Promise<number> {
    return this.docs.size;
  }

  async clearDocs(): Promise<void> {
    this.docs.clear();
  }

  async getCursor(stream: string): Promise<RecallCursor | null> {
    const c = this.cursors.get(stream);
    return c ? { ...c } : null;
  }

  async putCursor(cursor: RecallCursor): Promise<void> {
    this.cursors.set(cursor.stream, { ...cursor });
  }

  async clearCursors(): Promise<void> {
    this.cursors.clear();
  }
}
