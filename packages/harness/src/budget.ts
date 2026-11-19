import { z } from 'zod';
import { CancelledError, HarnessError } from './errors';
import type { Clock } from './ports';
import { systemClock } from './runtime';

export const BudgetLimitsSchema = z.object({
  maxSteps: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
  maxWallClockMs: z.number().int().positive().optional(),
});
export type BudgetLimits = z.infer<typeof BudgetLimitsSchema>;

export const BudgetDimensionSchema = z.enum(['steps', 'tokens', 'costUsd', 'wallClockMs']);
export type BudgetDimension = z.infer<typeof BudgetDimensionSchema>;

export type BudgetUsage = Record<BudgetDimension, number>;
export type BudgetCharge = Partial<Record<Exclude<BudgetDimension, 'wallClockMs'>, number>>;

export class BudgetExceededError extends HarnessError {
  readonly code = 'budget_exceeded';
  readonly dimension: BudgetDimension;
  readonly limit: number;
  readonly used: number;
  constructor(dimension: BudgetDimension, limit: number, used: number) {
    super(`Run budget exceeded: ${dimension} used ${used} > limit ${limit}`);
    this.dimension = dimension;
    this.limit = limit;
    this.used = used;
  }
}

const LIMIT_OF: Record<BudgetDimension, keyof BudgetLimits> = {
  steps: 'maxSteps',
  tokens: 'maxTokens',
  costUsd: 'maxCostUsd',
  wallClockMs: 'maxWallClockMs',
};

/**
 * Tracks a run's spend. `charge()` throws `BudgetExceededError` once any limit is crossed and
 * aborts `signal`, so in-flight work wired to the signal (LLM calls, fetches, sleeps) stops too.
 */
export class Budget {
  readonly limits: BudgetLimits;
  readonly #clock: Clock;
  readonly #startedAt: number;
  readonly #controller = new AbortController();
  #steps = 0;
  #tokens = 0;
  #costUsd = 0;

  constructor(limits: BudgetLimits, clock: Clock = systemClock) {
    this.limits = BudgetLimitsSchema.parse(limits);
    this.#clock = clock;
    this.#startedAt = clock.now().getTime();
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get usage(): BudgetUsage {
    return {
      steps: this.#steps,
      tokens: this.#tokens,
      costUsd: this.#costUsd,
      wallClockMs: this.#clock.now().getTime() - this.#startedAt,
    };
  }

  remaining(): Partial<BudgetUsage> {
    const usage = this.usage;
    const out: Partial<BudgetUsage> = {};
    for (const dim of BudgetDimensionSchema.options) {
      const limit = this.limits[LIMIT_OF[dim]];
      if (limit !== undefined) out[dim] = Math.max(0, limit - usage[dim]);
    }
    return out;
  }

  charge(charge: BudgetCharge): BudgetUsage {
    this.#steps += charge.steps ?? 0;
    this.#tokens += charge.tokens ?? 0;
    this.#costUsd += charge.costUsd ?? 0;
    return this.check();
  }

  /** Throws if any limit (including wall-clock) is exceeded; otherwise returns current usage. */
  check(): BudgetUsage {
    if (this.#controller.signal.aborted) throw abortReason(this.#controller.signal);
    const usage = this.usage;
    for (const dim of BudgetDimensionSchema.options) {
      const limit = this.limits[LIMIT_OF[dim]];
      if (limit !== undefined && usage[dim] > limit) {
        const err = new BudgetExceededError(dim, limit, usage[dim]);
        this.#controller.abort(err);
        throw err;
      }
    }
    return usage;
  }

  cancel(reason = 'Run cancelled'): void {
    this.#controller.abort(new CancelledError(reason));
  }
}

/** Harness errors (e.g. `BudgetExceededError`) pass through; any other reason becomes `CancelledError`. */
function abortReason(signal: AbortSignal): HarnessError {
  const reason: unknown = signal.reason;
  if (reason instanceof HarnessError) return reason;
  return new CancelledError(reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'Aborted');
}

/** Throws the signal's reason (a `HarnessError` when aborted by a `Budget`) if it is aborted. */
export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

/** Races `promise` against `signal`; rejects with the abort reason as soon as the signal fires. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** Combine signals (e.g. a budget's signal with a request's signal). */
export function anySignal(...signals: (AbortSignal | undefined)[]): AbortSignal {
  return AbortSignal.any(signals.filter((s): s is AbortSignal => s !== undefined));
}
