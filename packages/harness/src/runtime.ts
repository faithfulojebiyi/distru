import { CancelledError } from './errors';
import type { Clock, IdGenerator, StepRunner } from './ports';

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new CancelledError('Sleep aborted'));
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new CancelledError('Sleep aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

/** Non-durable runner: just calls the function. Use a durable runner (Inngest step.run) in production. */
export const inlineStepRunner: StepRunner = {
  run: (_stepId, fn) => fn(),
};

export const randomId: IdGenerator = () => crypto.randomUUID();

/**
 * Deterministic idempotency key for op `opIndex` of `proposalId`. Stable across retries, replays
 * and approver edits, so a write can always be found again. Short enough for a notes field.
 */
export async function idempotencyKeyFor(proposalId: string, opIndex: number): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${proposalId}:${opIndex}`));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return `opk_${hex.slice(0, 32)}`;
}
