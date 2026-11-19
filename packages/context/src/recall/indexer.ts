/**
 * Ingestion: documents in → chunks embedded and stored, deduplicated by document id (= source id).
 *
 * - A document whose content hash and embedder are unchanged is skipped (no embedding call).
 * - A changed document replaces all of its chunks (old chunks deleted first, so a shorter text
 *   never leaves stale chunks behind).
 * - The same id twice in one batch: the last one wins.
 * - `force` re-embeds everything given (reindex after changing the embedder or chunking).
 *
 * Incremental sources keep a cursor in the `RecallStore` (`runIncremental`).
 */
import { systemClock, type ContextClock } from '../util';
import { chunkDoc, contentHashOf, type ChunkOptions } from './chunk';
import type { Embedder } from './embedder';
import { RecallDocSchema, type RecallCursor, type RecallDoc, type RecallDocRecord } from './model';
import type { RecallStore, RecallVectorIndex } from './ports';

export interface RecallIndexerDeps {
  index: RecallVectorIndex;
  store: RecallStore;
  embedder: Embedder;
  clock?: ContextClock;
  chunk?: ChunkOptions;
  /** Texts per embedding call (default 32). */
  batchSize?: number;
}

export interface RecallIngestResult {
  received: number;
  indexed: number;
  unchanged: number;
  chunks: number;
  /** Documents with no text left after cleaning (nothing stored). */
  empty: number;
}

export interface RecallIndexer {
  readonly embedder: Embedder;
  ingest(docs: readonly RecallDoc[], opts?: { force?: boolean }): Promise<RecallIngestResult>;
  /**
   * One incremental pass of a cursor-based source: `fetch(since)` returns documents changed since the
   * cursor (null on the first run) and the new cursor; the cursor only advances when ingest succeeded.
   */
  runIncremental(stream: string, fetch: (since: string | null) => Promise<{ docs: RecallDoc[]; cursorAt: string }>, opts?: { force?: boolean }): Promise<RecallIngestResult & { stream: string; since: string | null; cursorAt: string }>;
  /** Forget everything (vectors, ledger, cursors): the next incremental passes start from scratch. */
  reset(): Promise<void>;
}

export function createRecallIndexer(deps: RecallIndexerDeps): RecallIndexer {
  const clock = deps.clock ?? systemClock;
  const batchSize = deps.batchSize ?? 32;
  let ensured = false;

  async function ensure() {
    if (ensured) return;
    await deps.index.ensure(deps.embedder.dimension);
    ensured = true;
  }

  async function ingest(input: readonly RecallDoc[], opts: { force?: boolean } = {}): Promise<RecallIngestResult> {
    const byId = new Map<string, RecallDoc>();
    for (const d of input) byId.set(d.id, RecallDocSchema.parse(d));
    const docs = [...byId.values()];
    const result: RecallIngestResult = { received: input.length, indexed: 0, unchanged: 0, chunks: 0, empty: 0 };
    if (!docs.length) return result;
    await ensure();
    const known = await deps.store.getDocs(docs.map((d) => d.id));
    const todo = docs.flatMap((doc) => {
      const hash = contentHashOf(doc, deps.chunk);
      const prev = known.get(doc.id);
      if (!opts.force && prev && prev.contentHash === hash && prev.embedder === deps.embedder.id) {
        result.unchanged++;
        return [];
      }
      return [{ doc, hash, replacing: !!prev }];
    });
    if (!todo.length) return result;

    const chunks = todo.flatMap(({ doc }) => chunkDoc(doc, deps.chunk));
    const vectors: number[][] = [];
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const out = await deps.embedder.embed(batch.map((c) => c.embedText));
      if (out.length !== batch.length) throw new Error(`embedder returned ${out.length} vectors for ${batch.length} texts`);
      vectors.push(...out);
    }
    const replaced = todo.filter((t) => t.replacing).map((t) => t.doc.id);
    if (replaced.length) await deps.index.deleteDocs(replaced);
    if (chunks.length) await deps.index.upsert(chunks.map((c, i) => ({ id: c.id, vector: vectors[i]!, meta: c.meta })));

    const now = clock.now().toISOString();
    const counts = new Map<string, number>();
    for (const c of chunks) counts.set(c.docId, (counts.get(c.docId) ?? 0) + 1);
    const records: RecallDocRecord[] = todo.map(({ doc, hash }) => ({ id: doc.id, source: doc.source, sourceId: doc.sourceId, contentHash: hash, chunkCount: counts.get(doc.id) ?? 0, embedder: deps.embedder.id, date: doc.date, indexedAt: now }));
    await deps.store.putDocs(records);
    result.indexed = records.length;
    result.empty = records.filter((r) => r.chunkCount === 0).length;
    result.chunks = chunks.length;
    return result;
  }

  return {
    embedder: deps.embedder,
    ingest,
    async runIncremental(stream, fetch, opts = {}) {
      const prev = await deps.store.getCursor(stream);
      const since = prev?.cursorAt ?? null;
      const { docs, cursorAt } = await fetch(since);
      const out = await ingest(docs, opts);
      const cursor: RecallCursor = { stream, cursorAt, lastRunAt: clock.now().toISOString(), lastStats: { received: out.received, indexed: out.indexed, unchanged: out.unchanged, chunks: out.chunks } };
      await deps.store.putCursor(cursor);
      return { ...out, stream, since, cursorAt };
    },
    async reset() {
      await ensure();
      await deps.index.clear();
      await deps.store.clearDocs();
      await deps.store.clearCursors();
    },
  };
}
