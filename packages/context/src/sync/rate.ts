/**
 * Response-header observer for the Distru client. The generated client returns bodies only, so the
 * sync reads `Date` (sync start time, per Distru's recipe) and `X-RateLimit-*` (list budget) through
 * a fetch wrapper:
 *
 * ```ts
 * const observer = createDistruObserver();
 * const client = createDistruClient({ baseUrl, token, fetch: observer.wrap(fetch) });
 * const sync = createDistruSync({ client, store, observer });
 * ```
 */
import type { FetchLike } from '@ops/distru-client';

export interface RateLimitState {
  limit: number | null;
  remaining: number | null;
  /** Seconds until the bucket is full again. */
  resetSeconds: number | null;
  /** When these headers were last seen (ISO). */
  observedAt: string | null;
}

export interface DistruObserver {
  wrap(fetch: FetchLike): FetchLike;
  readonly rateLimit: RateLimitState;
  /** `Date` header of the first response since the last `mark()`, or null. */
  firstDateSinceMark(): Date | null;
  mark(): void;
  /** Requests seen since construction. */
  readonly requests: number;
}

const int = (v: string | null): number | null => {
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function createDistruObserver(): DistruObserver {
  const rateLimit: RateLimitState = { limit: null, remaining: null, resetSeconds: null, observedAt: null };
  let firstDate: Date | null = null;
  let requests = 0;
  const observe = (res: Response) => {
    requests++;
    const date = res.headers.get('Date');
    if (date && !firstDate) {
      const t = Date.parse(date);
      if (!Number.isNaN(t)) firstDate = new Date(t);
    }
    const remaining = int(res.headers.get('X-RateLimit-Remaining'));
    if (remaining !== null) {
      rateLimit.remaining = remaining;
      rateLimit.limit = int(res.headers.get('X-RateLimit-Limit')) ?? rateLimit.limit;
      rateLimit.resetSeconds = int(res.headers.get('X-RateLimit-Reset'));
      rateLimit.observedAt = new Date().toISOString();
    }
  };
  return {
    wrap: (fetch) => async (input, init) => {
      const res = await fetch(input, init);
      observe(res);
      return res;
    },
    rateLimit,
    firstDateSinceMark: () => firstDate,
    mark: () => {
      firstDate = null;
    },
    get requests() {
      return requests;
    },
  };
}
