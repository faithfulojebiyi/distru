import { z } from 'zod';
import { HarnessError } from './errors';
import type { Clock, ErrorClassifier, ErrorContext } from './ports';
import { throwIfCancelled } from './budget';

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().positive().default(4),
  baseDelayMs: z.number().nonnegative().default(250),
  maxDelayMs: z.number().nonnegative().default(10_000),
});
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const neverRetry: ErrorClassifier = { isRetryable: () => false };

/**
 * One classifier per connector, routed by the failing op's connector id (`ErrorContext`). Errors
 * without a context, or from an op whose connector has no entry, go to `fallback` (default: retryable
 * if any of the connector classifiers says so, taking the first Retry-After).
 *
 * ```ts
 * errors: routeErrorClassifier({ distru: distruErrorClassifier, email: emailErrorClassifier, distru_mcp: mcpErrorClassifier })
 * ```
 */
export function routeErrorClassifier(byConnector: Readonly<Record<string, ErrorClassifier>>, fallback?: ErrorClassifier): ErrorClassifier {
  const all = Object.values(byConnector);
  const any: ErrorClassifier = fallback ?? {
    isRetryable: (err, ctx) => all.some((c) => c.isRetryable(err, ctx)),
    retryAfterMs: (err, ctx) => {
      for (const c of all) {
        if (!c.isRetryable(err, ctx)) continue;
        const ms = c.retryAfterMs?.(err, ctx);
        if (ms !== undefined) return ms;
      }
      return undefined;
    },
  };
  const pick = (ctx: ErrorContext | undefined): ErrorClassifier => (ctx?.connectorId && Object.hasOwn(byConnector, ctx.connectorId) ? byConnector[ctx.connectorId]! : any);
  return {
    isRetryable: (err, ctx) => pick(ctx).isRetryable(err, ctx),
    retryAfterMs: (err, ctx) => pick(ctx).retryAfterMs?.(err, ctx),
  };
}

/** Exponential backoff with full jitter: uniform in [0, min(max, base · 2^(attempt-1))]. */
export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number = Math.random): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.round(random() * ceiling);
}

export interface RetryOptions {
  policy: RetryPolicy;
  classifier: ErrorClassifier;
  /** Passed to the classifier (which op failed). */
  context?: ErrorContext;
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
      const retryable = !(error instanceof HarnessError) && opts.classifier.isRetryable(error, opts.context);
      if (!retryable) throw error;
      if (attempt >= opts.policy.maxAttempts) throw new RetriesExhaustedError(attempt, error);
      const retryAfter = opts.classifier.retryAfterMs?.(error, opts.context);
      const delayMs = retryAfter !== undefined ? Math.max(0, retryAfter) : backoffDelay(attempt, opts.policy, opts.random);
      await opts.onRetry?.({ attempt, delayMs, error });
      await opts.clock.sleep(delayMs, opts.signal);
    }
  }
}
