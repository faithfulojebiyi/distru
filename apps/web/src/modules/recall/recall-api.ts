import { useQuery, useQueryClient } from '@tanstack/react-query';

import { searchRecall } from '../../api/generated/context/context';
import { getQueryScope } from '../../lib/query';

/** Every recall query key, built here so invalidation always matches by prefix. */
export const recallKeys = {
  search: (scope: string, q: string) => ['recall', scope, 'search', q] as const,
};

/**
 * Semantic search over vendor email, vendor replies and PO notes (GET /api/recall/search). Runs only for
 * a query of at least 2 characters; the screen renders its own empty / error states.
 */
export const useRecallSearch = (query: string) => {
  const client = useQueryClient();
  const q = query.trim();
  return useQuery({
    queryKey: recallKeys.search(getQueryScope(client), q),
    queryFn: ({ signal }) => searchRecall({ q, limit: 5 }, { signal }),
    enabled: q.length >= 2,
    staleTime: 60_000,
    meta: { suppressErrorToast: true },
  });
};
