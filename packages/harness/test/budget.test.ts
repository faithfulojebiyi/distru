import { describe, expect, test } from 'bun:test';
import {
  abortable,
  anySignal,
  backoffDelay,
  Budget,
  BudgetExceededError,
  CancelledError,
  FakeClock,
  RetriesExhaustedError,
  RetryPolicySchema,
  throwIfCancelled,
  withRetry,
} from '../src';
import { HttpError, httpClassifier } from './fixtures';

describe('Budget', () => {
  test('tracks steps, tokens and cost; throws a typed error when a limit is crossed', () => {
    const budget = new Budget({ maxSteps: 3, maxTokens: 1000, maxCostUsd: 0.5 }, new FakeClock());
    budget.charge({ steps: 1, tokens: 400, costUsd: 0.1 });
    budget.charge({ steps: 1, tokens: 500, costUsd: 0.2 });
    expect(budget.usage).toMatchObject({ steps: 2, tokens: 900, costUsd: 0.30000000000000004 });
    expect(budget.remaining()).toMatchObject({ steps: 1, tokens: 100 });

    let caught: unknown;
    try {
      budget.charge({ tokens: 200 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BudgetExceededError);
    expect(caught).toMatchObject({ code: 'budget_exceeded', dimension: 'tokens', limit: 1000, used: 1100 });
  });

  test('exceeding aborts the budget signal with the error as reason; later charges keep failing', () => {
    const budget = new Budget({ maxCostUsd: 1 }, new FakeClock());
    expect(() => budget.charge({ costUsd: 2 })).toThrow(BudgetExceededError);
    expect(budget.signal.aborted).toBe(true);
    expect(budget.signal.reason).toBeInstanceOf(BudgetExceededError);
    expect(() => budget.charge({})).toThrow(BudgetExceededError);
  });

  test('wall-clock limit is enforced from the injected clock', () => {
    const clock = new FakeClock();
    const budget = new Budget({ maxWallClockMs: 5_000 }, clock);
    clock.advance(4_000);
    expect(budget.check().wallClockMs).toBe(4_000);
    clock.advance(2_000);
    expect(() => budget.check()).toThrow(BudgetExceededError);
  });

  test('cancel() aborts with CancelledError', () => {
    const budget = new Budget({}, new FakeClock());
    budget.cancel('user hit stop');
    expect(() => throwIfCancelled(budget.signal)).toThrow(CancelledError);
  });

  test('rejects invalid limits', () => {
    expect(() => new Budget({ maxSteps: -1 })).toThrow();
  });
});

describe('cancellation helpers', () => {
  test('abortable rejects as soon as the signal fires; plain aborts become CancelledError', async () => {
    const controller = new AbortController();
    const never = new Promise<string>(() => {});
    const raced = abortable(never, controller.signal);
    controller.abort();
    await expect(raced).rejects.toBeInstanceOf(CancelledError);
    await expect(abortable(Promise.resolve('ok'), new AbortController().signal)).resolves.toBe('ok');
  });

  test('anySignal combines signals', () => {
    const a = new AbortController();
    const b = new AbortController();
    const combined = anySignal(a.signal, undefined, b.signal);
    b.abort();
    expect(combined.aborted).toBe(true);
  });
});

describe('retry', () => {
  const policy = RetryPolicySchema.parse({ baseDelayMs: 100, maxDelayMs: 1_000 });

  test('full-jitter exponential backoff is capped', () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n, policy, () => 1))).toEqual([100, 200, 400, 800, 1000, 1000]);
    expect(backoffDelay(3, policy, () => 0)).toBe(0);
  });

  test('withRetry: non-retryable errors are thrown immediately', async () => {
    const clock = new FakeClock();
    let calls = 0;
    const run = withRetry(async () => {
      calls++;
      throw new HttpError(422);
    }, { policy, classifier: httpClassifier, clock });
    await expect(run).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  test('withRetry: exhausting attempts wraps the last error', async () => {
    const clock = new FakeClock();
    const run = withRetry(async () => {
      throw new HttpError(500);
    }, { policy: { ...policy, maxAttempts: 2 }, classifier: httpClassifier, clock, random: () => 1 });
    await expect(run).rejects.toBeInstanceOf(RetriesExhaustedError);
    expect(clock.sleeps).toEqual([100]);
  });

  test('withRetry: harness errors (budget) are never retried', async () => {
    let calls = 0;
    const run = withRetry(async () => {
      calls++;
      throw new BudgetExceededError('steps', 1, 2);
    }, { policy, classifier: { isRetryable: () => true }, clock: new FakeClock() });
    await expect(run).rejects.toBeInstanceOf(BudgetExceededError);
    expect(calls).toBe(1);
  });
});
