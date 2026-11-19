import { DistruApiError } from '@ops/distru-client';
import type { ErrorClassifier } from '@ops/harness';

/** Distru 429 and 5xx are transient; 400/401/403/404 are not (retrying cannot fix them). */
export function isRetryableDistruError(err: unknown): boolean {
  return err instanceof DistruApiError && (err.status === 429 || err.status >= 500);
}

/**
 * Harness `ErrorClassifier` for Distru: 429/5xx retryable; a 429's `Retry-After` (seconds) is
 * honoured by the harness instead of its own backoff.
 */
export const distruErrorClassifier: ErrorClassifier = {
  isRetryable: isRetryableDistruError,
  retryAfterMs: (err) =>
    err instanceof DistruApiError && err.retryAfterSeconds !== undefined ? err.retryAfterSeconds * 1000 : undefined,
};
