/**
 * Recall behind the API (`GET /api/recall/search`) and the Inngest indexing functions: wiring of the
 * process-wide singletons (PgVector recall, context store, Composio client).
 */
import type { Recall, RecallSearchInput } from '@ops/context';
import { appContextStore, appRecall } from '../context';
import type { RecallPassDeps } from '../context/recall';
import type { RecallSearchResponse } from '../api/schemas-insight';
import { appConnectors } from '../harness/registry';

export class RecallDisabledError extends Error {
  constructor() {
    super('Semantic recall is disabled (RECALL_ENABLED=0)');
    this.name = 'RecallDisabledError';
  }
}

export interface RecallApiService {
  enabled: boolean;
  /** Throws RecallDisabledError when disabled; input errors are zod errors. */
  search: (input: RecallSearchInput) => Promise<RecallSearchResponse>;
}

export function recallSearchService(recall: Pick<Recall, 'search' | 'service'> & { indexer: { embedder: { id: string } } }, enabled: boolean): RecallApiService {
  return {
    enabled,
    search: async (input) => {
      if (!enabled) throw new RecallDisabledError();
      const [result, stats] = await Promise.all([recall.search(input), recall.service.stats?.() ?? Promise.resolve(null)]);
      return { ...result, embedder: recall.indexer.embedder.id, documents: stats?.documents ?? null };
    },
  };
}

/** What an indexing pass runs against: the app's recall, synced vendors and the (current) Composio client. */
export const recallPassDeps = (): RecallPassDeps => ({ indexer: appRecall.indexer, contextStore: appContextStore, composio: () => appConnectors.composioClient() });
