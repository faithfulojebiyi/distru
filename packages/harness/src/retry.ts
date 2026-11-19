import { z } from 'zod';
import { HarnessError } from './errors';
import type { Clock, ErrorClassifier } from './ports';
import { throwIfCancelled } from './budget';

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().positive().default(4),
  baseDelayMs: z.number().nonnegative().default(250),
  maxDelayMs: z.number().nonnegative().default(10_000),
});
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const neverRetry: ErrorClassifier = { isRetryable: () => false };

/** Exponential backoff with full jitter: uniform in [0, min(max, base · 2^(attempt-1))]. */
export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number = Math.random): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.round(random() * ceiling);
}

export interface RetryOptions {
  policy: RetryPolicy;
  classifier: ErrorClassifier;
  clock: Clock;
  random?: () => number;
  signal?: AbortSignal;
  onRetry?(info: { attempt: number; delayMs: number; error: unknown }): Promise<void> | void;
}

export class RetriesExhaustedError extends Error {
  override readonly name = 'RetriesExhaustedError';
  readonly attempts: number;
  override readonly cause: unknown;
  constructor(attempts: number, cause: unknown) {
    super(`Failed after ${attempts} attempt(s): ${cause instanceof Error ? cause.message : String(cause)}`);
    this.attempts = attempts;
    this.cause = cause;
  }
}

/**
 * Runs `fn` until it succeeds, a non-retryable error is thrown, or attempts run out. A
 * classifier-supplied `retryAfterMs` (e.g. Distru 429 `Retry-After`) overrides the backoff.
 * Harness errors (budget, cancellation) are never retried. Resolves with the value and attempt count.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<{ value: T; attempts: number }> {
  for (let attempt = 1; ; attempt++) {
    throwIfCancelled(opts.signal);
    try {
      return { value: await fn(attempt), attempts: attempt };
    } catch (error) {
      const retryable = !(error instanceof HarnessError) && opts.classifier.isRetryable(error);
      if (!retryable) throw error;
      if (attempt >= opts.policy.maxAttempts) throw new RetriesExhaustedError(attempt, error);
      const retryAfter = opts.classifier.retryAfterMs?.(error);
      const delayMs = retryAfter !== undefined ? Math.max(0, retryAfter) : backoffDelay(attempt, opts.policy, opts.random);
      await opts.onRetry?.({ attempt, delayMs, error });
      await opts.clock.sleep(delayMs, opts.signal);
    }
  }
}
