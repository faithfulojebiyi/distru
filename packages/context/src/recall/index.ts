/**
 * Semantic recall over unstructured text (emails, vendor replies, PO notes), alongside the relational
 * context layer. Ports: `Embedder`, `RecallVectorIndex`, `RecallStore`; adapters here are in-memory /
 * dependency-free, the app supplies PgVector + FastEmbed + Drizzle (`@ops/context/drizzle`).
 */
import type { ContextClock } from '../util';
import type { ChunkOptions } from './chunk';
import type { RecallService } from './connector';
import type { Embedder } from './embedder';
import { createRecallIndexer, type RecallIndexer } from './indexer';
import type { RecallStore, RecallVectorIndex } from './ports';
import { createRecallSearch, type RecallSearchFn } from './search';

export * from './model';
export * from './chunk';
export * from './embedder';
export * from './ports';
export * from './indexer';
export * from './sources';
export * from './search';
export * from './connector';

export interface Recall {
  indexer: RecallIndexer;
  search: RecallSearchFn;
  /** For `ctx.connectors.recall`. */
  service: RecallService;
}

/** Indexer + search + connector service over one index, ledger and embedder. */
export function createRecall(deps: { index: RecallVectorIndex; store: RecallStore; embedder: Embedder; clock?: ContextClock; chunk?: ChunkOptions }): Recall {
  const indexer = createRecallIndexer(deps);
  const search = createRecallSearch(deps);
  return { indexer, search, service: { search, stats: async () => ({ documents: await deps.store.countDocs(), embedder: deps.embedder.id }) } };
}
