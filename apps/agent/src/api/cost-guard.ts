import type { Context, MiddlewareHandler } from 'hono';
import { cacheUsageOf } from '../mastra/workflows/agent-call';
import { estimateCostUsd, type Pricing } from '../mastra/trace';

/**
 * Cost guard for the routes that spend LLM tokens: the Copilot (`POST /api/agents/ops-lead/stream|generate`),
 * `POST /api/runs` and A2A (`POST /api/a2a/ops-lead`).
 *
 * - Per-user rate limit (AGENT_RATE_LIMIT_PER_HOUR; default 30 in DEMO_MODE, else off): a sliding one-hour
 *   window per signed-in user (or per A2A token). Only accepted requests count.
 * - Global daily spend cap (DAILY_SPEND_CAP_USD; default $10 in DEMO_MODE, else off): every agent's finished
 *   call reports its usage (`onUsage` on the agents → `SpendLedger.addUsage`, priced with LLM_*_USD_PER_MTOK,
 *   the same estimate the run budgets and the Runs page use). Once today's (UTC) estimate reaches the cap,
 *   agent requests get 429 until midnight UTC.
 *
 * Both answer `429 { error: 'rate_limited' | 'daily_spend_cap', message }` with `Retry-After`; the Copilot shows
 * the message. In memory, per process: a restart resets the window and the day's total (fine for a single-node
 * demo; not billing data).
 */

/** UTC day key, e.g. 2026-11-20. */
const dayOf = (at: Date) => at.toISOString().slice(0, 10);

export class SpendLedger {
  #day: string;
  #usd = 0;

  constructor(
    private readonly pricing: Pricing,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#day = dayOf(now());
  }

  #roll(): void {
    const today = dayOf(this.now());
    if (today !== this.#day) {
      this.#day = today;
      this.#usd = 0;
    }
  }

  add(usd: number): void {
    if (!Number.isFinite(usd) || usd <= 0) return;
    this.#roll();
    this.#usd += usd;
  }

  /** A finished agent call's usage (AI SDK shape: inputTokens, outputTokens, cachedInputTokens, …). */
  addUsage(usage: unknown): void {
    this.add(estimateCostUsd(cacheUsageOf(usage), this.pricing));
  }

  spentToday(): number {
    this.#roll();
    return Math.round(this.#usd * 1_000_000) / 1_000_000;
  }

  /** Seconds until the next UTC midnight (Retry-After for the daily cap). */
  secondsToReset(): number {
    const at = this.now();
    const midnight = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1);
    return Math.max(1, Math.ceil((midnight - at.getTime()) / 1000));
  }
}

const HOUR_MS = 3_600_000;

/** Sliding-window limiter: at most `limit` hits per key in any hour. */
export class HourlyRateLimiter {
  readonly #hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Records a hit when under the limit; otherwise how long until the oldest hit leaves the window. */
  hit(key: string): { ok: true } | { ok: false; retryAfterSec: number } {
    const at = this.now().getTime();
    const recent = (this.#hits.get(key) ?? []).filter((t) => at - t < HOUR_MS);
    if (recent.length >= this.limit) {
      this.#hits.set(key, recent);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((recent[0]! + HOUR_MS - at) / 1000)) };
    }
    recent.push(at);
    this.#hits.set(key, recent);
    // Keep the map small: forget keys with nothing in the window.
    if (this.#hits.size > 10_000) for (const [k, v] of this.#hits) if (!v.some((t) => at - t < HOUR_MS)) this.#hits.delete(k);
    return { ok: true };
  }
}

export interface CostGuardOptions {
  /** null = no per-user limit. */
  limiter: HourlyRateLimiter | null;
  ledger: SpendLedger;
  /** null = no daily cap. */
  dailyCapUsd: number | null;
  /** Who is calling (`user:<id>`, `token:<…>`), or null when unauthenticated (the route's own auth answers 401). */
  callerOf: (c: Context) => Promise<string | null>;
}

/** Whether the guard applies: POST to an agent-spending route. */
export function isGuardedRequest(method: string, path: string): boolean {
  if (method.toUpperCase() !== 'POST') return false;
  return path === '/api/runs' || /^\/api\/agents\/[^/]+\/(?:stream|generate)$/.test(path) || /^\/api\/a2a\/[^/]+$/.test(path);
}

export function costGuard(options: CostGuardOptions): MiddlewareHandler {
  return async (c, next) => {
    if (!isGuardedRequest(c.req.method, c.req.path)) return next();
    if (options.dailyCapUsd !== null && options.ledger.spentToday() >= options.dailyCapUsd) {
      c.header('Retry-After', String(options.ledger.secondsToReset()));
      return c.json(
        { error: 'daily_spend_cap', message: "Today's AI budget for this demo is used up. The Ops Agent is back at 00:00 UTC; everything else still works." },
        429,
      );
    }
    if (options.limiter) {
      const caller = await options.callerOf(c).catch(() => null);
      if (caller) {
        const verdict = options.limiter.hit(caller);
        if (!verdict.ok) {
          c.header('Retry-After', String(verdict.retryAfterSec));
          const minutes = Math.ceil(verdict.retryAfterSec / 60);
          return c.json(
            {
              error: 'rate_limited',
              message: `You've reached the limit of ${options.limiter.limit} agent requests per hour. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
            },
            429,
          );
        }
      }
    }
    return next();
  };
}
