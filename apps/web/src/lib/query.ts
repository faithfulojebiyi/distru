import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';

import {
  apiErrorMessage,
  isNetworkError,
  isNotFoundError,
  isSessionExpiredError,
} from '../api/errors';
import { toast } from '@ops/ui/primitives/toast/toast';

export const makeQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        // A missing resource does not come back on a second try; an unreachable server usually does (a restart),
        // so network errors retry three times with backoff (1s, 2s, 4s, capped at 8s) before the screen shows it.
        retry: (failures, error) => {
          if (isNetworkError(error)) return failures < 3;
          return !isNotFoundError(error) && failures < 1;
        },
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
        // above zero so SSR does not refetch everything immediately on hydrate
        staleTime: 30_000,
      },
    },
    /**
     * One place for read failures, so a screen does not have to remember to
     * report them. A query opts out with meta.suppressErrorToast when it
     * renders its own empty or error state, or with meta.suppressNotFoundToast
     * when its screen handles a missing resource itself.
     */
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (isSessionExpiredError(error)) return;
        // The offline banner reports an unreachable server once, instead of a toast per query.
        if (isNetworkError(error)) return;
        if (query.meta?.suppressErrorToast) return;
        if (query.meta?.suppressNotFoundToast && isNotFoundError(error)) return;

        toast.error(apiErrorMessage(error));
      },
    }),
    /** Write failures surface here unless the mutation reports them itself through its own onError. */
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (isSessionExpiredError(error)) return;
        if (mutation.options.onError) return;
        if (isNetworkError(error)) return void toast.error('Can’t reach the agent server. Nothing was saved; try again in a moment.');

        toast.error(apiErrorMessage(error));
      },
    }),
  });

let browserQueryClient: QueryClient | undefined;

/**
 * A fresh client per server render — a module singleton would leak one user's
 * cache into another's response. In the browser it is created once: React may
 * suspend during the initial render, and rebuilding the client there would
 * throw the cache away.
 */
export const getQueryClient = (): QueryClient => {
  if (typeof window === 'undefined') return makeQueryClient();

  browserQueryClient ??= makeQueryClient();

  return browserQueryClient;
};

/**
 * Each feature keeps its own query-key factory next to its hooks (for example
 * `sessionKeys` in modules/session/session-api.ts). Invalidation matches by
 * prefix, so always build keys from the factory: a mutation that invalidates a
 * literal it typed itself fails silently and the screen shows stale data.
 */

/** Whose cache this is: the signed-in user's id, or '' when signed out. */
export type QueryScope = string;
const queryScopes = new WeakMap<QueryClient, QueryScope>();
const anonymousScope: QueryScope = '';
export const getQueryScope = (client: QueryClient): QueryScope =>
  queryScopes.get(client) ?? anonymousScope;

/** Switch before mounting authenticated queries, so one user's cache never shows under another. */
export const setQueryScope = (client: QueryClient, scope: QueryScope) => {
  if (getQueryScope(client) === scope) return;
  queryScopes.set(client, scope);
  void client.cancelQueries();
  client.clear();
};

export const clearSessionQueries = (client: QueryClient) => {
  queryScopes.set(client, anonymousScope);
  void client.cancelQueries();
  client.clear();
};
