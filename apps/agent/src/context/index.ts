import { DrizzleRecallStore } from '@ops/context/drizzle';
import { db } from '../db/client';
import { env } from '../env';
import { createAppContextStore, createAppContextSync } from './app-context';
import { createEmbedder, createPgRecall, indexPurchaseNotes } from './recall';

/** Process-wide context store (Postgres schema `context`). */
export const appContextStore = createAppContextStore(db);

/**
 * Semantic recall: PgVector (schema `recall`) + the local embedder + the Drizzle ledger. Built even
 * when RECALL_ENABLED=0 (nothing is registered or indexed then; the object is inert until used).
 */
export const appRecall = createPgRecall({ connectionString: env.DATABASE_URL, store: new DrizzleRecallStore(db), embedder: createEmbedder(env.RECALL_EMBEDDER) });

/** Distru sync (observer-wrapped client); purchase descriptions / notes go to the recall index. */
export const appContextSync = createAppContextSync(appContextStore, {
  baseUrl: env.DISTRU_BASE_URL,
  token: env.DISTRU_API_TOKEN,
  ...(env.RECALL_ENABLED
    ? {
        onFreeText: (_stream: 'purchases', raws: readonly unknown[], syncedAt: string) => indexPurchaseNotes({ indexer: appRecall.indexer, contextStore: appContextStore }, raws, syncedAt),
        onFreeTextError: (err: unknown) => console.warn(`[recall] PO notes not indexed: ${err instanceof Error ? err.message : String(err)}`),
      }
    : {}),
});
