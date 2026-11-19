/**
 * Rate limiting as Distru documents it:
 *
 * - REST list budget (docs/research/guides/incremental-sync.md "List rate limits"): one account bucket
 *   of 3,000 calls refilling 5/minute, shared by the paginated list endpoints with an
 *   `updated_datetime` filter. A call whose `updated_datetime` lower bound is within the last 30 days
 *   is free and never refused; every other call (ids lookups, upper-bound-only, 400s) costs one.
 *   `/activity` is free without `changed_datetime` or with a lower bound within 30 days.
 *   Get-by-id, /inventory, reports, Metrc lists, record history: unlimited.
 * - REST PDF limit (guides/rate-limiting.md): 20 successful downloads/minute and 1,000/day per account,
 *   sliding windows; only 2xx downloads count.
 * - MCP (mcp/mcp_limits.md), per user: 40 back to back, 120/minute, 3,000/hour, writes 20/minute,
 *   PDFs 20/minute + 1,000/day, 6 in flight per credential.
 */

export type Clock = () => number;

const MIN = 60_000;

/** Classic token bucket: `capacity` tokens, refilled continuously at `refillPerMinute`. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    public capacity: number,
    public refillPerMinute: number,
    private readonly clock: Clock,
    initial = capacity,
  ) {
    this.tokens = initial;
    this.last = clock();
  }

  private refill(): void {
    const now = this.clock();
    const elapsed = Math.max(0, now - this.last);
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.refillPerMinute) / MIN);
  }

  available(): number {
    this.refill();
    return this.tokens;
  }

  /** Whole tokens left (what `X-RateLimit-Remaining` reports). */
  remaining(): number {
    return Math.floor(this.available());
  }

  canTake(n = 1): boolean {
    return this.available() >= n;
  }

  take(n = 1): boolean {
    if (!this.canTake(n)) return false;
    this.tokens -= n;
    return true;
  }

  /** Seconds until `n` tokens are available (0 when they already are). */
  waitSeconds(n = 1): number {
    const missing = n - this.available();
    if (missing <= 0) return 0;
    if (this.refillPerMinute <= 0) return Number.POSITIVE_INFINITY;
    return Math.ceil((missing * MIN) / this.refillPerMinute / 1000);
  }

  /** Seconds until the bucket is full again (what `X-RateLimit-Reset` reports). */
  resetSeconds(): number {
    const missing = this.capacity - this.available();
    if (missing <= 0 || this.refillPerMinute <= 0) return 0;
    return Math.ceil((missing * MIN) / this.refillPerMinute / 1000);
  }

  set(tokens: number): void {
    this.refill();
    this.tokens = Math.max(0, Math.min(this.capacity, tokens));
  }

  reconfigure(capacity: number, refillPerMinute: number): void {
    this.refill();
    this.capacity = capacity;
    this.refillPerMinute = refillPerMinute;
    this.tokens = Math.min(this.tokens, capacity);
  }
}

/** Sliding window of successful events (the PDF limits). */
export class SlidingWindow {
  private events: number[] = [];
  constructor(
    public limit: number,
    public windowMs: number,
    private readonly clock: Clock,
  ) {}

  private prune(): void {
    const from = this.clock() - this.windowMs;
    while (this.events.length && this.events[0]! <= from) this.events.shift();
  }

  allowed(): boolean {
    this.prune();
    return this.events.length < this.limit;
  }

  remaining(): number {
    this.prune();
    return Math.max(0, this.limit - this.events.length);
  }

  /** Seconds until the oldest counted event ages out. */
  retryAfterSeconds(): number {
    this.prune();
    if (this.events.length < this.limit) return 0;
    const oldest = this.events[this.events.length - this.limit]!;
    return Math.max(1, Math.ceil((oldest + this.windowMs - this.clock()) / 1000));
  }

  record(): void {
    this.events.push(this.clock());
  }

  reset(): void {
    this.events = [];
  }
}

// ── REST ─────────────────────────────────────────────────────────────────────────────────────────

export interface RestListLimitConfig {
  /** false disables the bucket entirely (the legacy fail_next/every toggles still apply) */
  enabled: boolean;
  capacity: number;
  refill_per_minute: number;
  /** an `updated_datetime` lower bound newer than this many days ago is free */
  free_window_days: number;
}

export interface PdfLimitConfig {
  per_minute: number;
  per_day: number;
}

export const DEFAULT_REST_LIST_LIMIT: RestListLimitConfig = { enabled: true, capacity: 3000, refill_per_minute: 5, free_window_days: 30 };
export const DEFAULT_PDF_LIMIT: PdfLimitConfig = { per_minute: 20, per_day: 1000 };

/** Paginated list endpoints with an `updated_datetime` filter that the mock serves. */
export const LIMITED_LIST_PATHS = new Set([
  '/public/v1/orders',
  '/public/v1/purchases',
  '/public/v1/batches',
  '/public/v1/locations',
  '/public/v1/test-results',
  '/public/v1/products',
  '/public/v1/companies',
  '/public/v1/tasks',
  '/public/v1/invoices',
  '/public/v1/payments',
  '/public/v1/users',
]);
export const ACTIVITY_PATH = '/public/v1/activity';

/** Lower bound of a `min,max` range param, or null when absent/empty/unparsable. */
export function lowerBound(range: string | null): number | null {
  if (!range) return null;
  const [a = ''] = range.split(',');
  if (!a.trim()) return null;
  const t = Date.parse(a.trim());
  return Number.isNaN(t) ? null : t;
}

export class RestRateLimiter {
  readonly bucket: TokenBucket;
  readonly pdfMinute: SlidingWindow;
  readonly pdfDay: SlidingWindow;
  constructor(
    public config: RestListLimitConfig,
    public pdf: PdfLimitConfig,
    readonly clock: Clock,
  ) {
    this.bucket = new TokenBucket(config.capacity, config.refill_per_minute, clock);
    this.pdfMinute = new SlidingWindow(pdf.per_minute, MIN, clock);
    this.pdfDay = new SlidingWindow(pdf.per_day, 24 * 60 * MIN, clock);
  }

  /** Whether a GET to this path/query is governed by the list budget, and whether it is free. */
  classify(path: string, sp: URLSearchParams): { limited: false } | { limited: true; free: boolean } {
    const freeFrom = this.clock() - this.config.free_window_days * 24 * 60 * MIN;
    if (path === ACTIVITY_PATH) {
      const changed = sp.get('changed_datetime');
      const lb = lowerBound(changed);
      return { limited: true, free: !changed || (lb !== null && lb >= freeFrom) };
    }
    if (!LIMITED_LIST_PATHS.has(path)) return { limited: false };
    const lb = lowerBound(sp.get('updated_datetime'));
    return { limited: true, free: lb !== null && lb >= freeFrom };
  }

  headers(): Record<string, string> {
    return {
      'X-RateLimit-Limit': String(this.bucket.capacity),
      'X-RateLimit-Remaining': String(this.bucket.remaining()),
      'X-RateLimit-Reset': String(this.bucket.resetSeconds()),
    };
  }

  reconfigure(config: Partial<RestListLimitConfig>, pdf: Partial<PdfLimitConfig>): void {
    Object.assign(this.config, config);
    Object.assign(this.pdf, pdf);
    this.bucket.reconfigure(this.config.capacity, this.config.refill_per_minute);
    this.pdfMinute.limit = this.pdf.per_minute;
    this.pdfDay.limit = this.pdf.per_day;
  }

  /** PDF check: `null` when allowed, else Retry-After seconds. Record with `pdfSucceeded()`. */
  pdfRetryAfter(): number | null {
    if (this.pdfMinute.allowed() && this.pdfDay.allowed()) return null;
    return Math.max(this.pdfMinute.allowed() ? 0 : this.pdfMinute.retryAfterSeconds(), this.pdfDay.allowed() ? 0 : this.pdfDay.retryAfterSeconds());
  }

  pdfSucceeded(): void {
    this.pdfMinute.record();
    this.pdfDay.record();
  }

  reset(): void {
    this.bucket.set(this.config.capacity);
    this.pdfMinute.reset();
    this.pdfDay.reset();
  }
}

// ── MCP ──────────────────────────────────────────────────────────────────────────────────────────

export interface McpRateLimitConfig {
  /** tool calls back to back (bucket capacity, refilled at per_minute) */
  burst: number;
  per_minute: number;
  per_hour: number;
  writes_per_minute: number;
  pdf_per_minute: number;
  pdf_per_day: number;
  /** tool calls in flight at once, per credential */
  max_in_flight: number;
  /** a JSON-RPC batch with more tool calls than this is refused with 400 */
  max_batch: number;
  /** test toggle: the next N tool calls get a 429 regardless of budget */
  fail_next: number;
  /** Retry-After seconds for fail_next 429s */
  retry_after: number;
  /** test toggle: artificial delay per tool call (to exercise the in-flight limit) */
  latency_ms: number;
}

export const DEFAULT_MCP_LIMIT: McpRateLimitConfig = {
  burst: 40,
  per_minute: 120,
  per_hour: 3000,
  writes_per_minute: 20,
  pdf_per_minute: 20,
  pdf_per_day: 1000,
  max_in_flight: 6,
  max_batch: 6,
  fail_next: 0,
  retry_after: 2,
  latency_ms: 0,
};

export type McpLimitName = 'burst' | 'per_hour' | 'writes_per_minute' | 'pdf_per_minute' | 'pdf_per_day' | 'max_in_flight' | 'simulated';

const LIMIT_TEXT: Record<McpLimitName, (c: McpRateLimitConfig) => string> = {
  burst: (c) => `tool calls back to back (${c.burst}, refilling ${c.per_minute} per minute)`,
  per_hour: (c) => `tool calls per hour (${c.per_hour})`,
  writes_per_minute: (c) => `write tool calls per minute (${c.writes_per_minute})`,
  pdf_per_minute: (c) => `PDF tool calls per minute (${c.pdf_per_minute})`,
  pdf_per_day: (c) => `PDF tool calls per day (${c.pdf_per_day})`,
  max_in_flight: (c) => `tool calls in flight at once (${c.max_in_flight})`,
  simulated: () => 'simulated limit (mock fail_next)',
};

export type McpLimitResult =
  | { ok: true; remaining: number; reset: number }
  | { ok: false; limit: McpLimitName; message: string; retryAfter: number; quota: { remaining: number; reset: number } | null };

interface UserBuckets {
  /** burst: capacity `burst`, refilled at per_minute → "40 back to back, 120/min" */
  burst: TokenBucket;
  hour: TokenBucket;
  writes: TokenBucket;
  pdfMinute: TokenBucket;
  pdfDay: TokenBucket;
}

export class McpRateLimiter {
  private users = new Map<string, UserBuckets>();
  private inFlight = new Map<string, number>();
  constructor(
    public config: McpRateLimitConfig,
    private readonly clock: Clock,
  ) {}

  private buckets(userId: string): UserBuckets {
    let b = this.users.get(userId);
    if (!b) {
      const c = this.config;
      b = {
        burst: new TokenBucket(c.burst, c.per_minute, this.clock),
        hour: new TokenBucket(c.per_hour, c.per_hour / 60, this.clock),
        writes: new TokenBucket(c.writes_per_minute, c.writes_per_minute, this.clock),
        pdfMinute: new TokenBucket(c.pdf_per_minute, c.pdf_per_minute, this.clock),
        pdfDay: new TokenBucket(c.pdf_per_day, c.pdf_per_day / (24 * 60), this.clock),
      };
      this.users.set(userId, b);
    }
    return b;
  }

  /** Charges one tool call; refuses (without charging anything) when any applicable limit is spent. */
  charge(userId: string, kind: 'read' | 'write', pdf: boolean): McpLimitResult {
    const c = this.config;
    const b = this.buckets(userId);
    const applicable: [McpLimitName, TokenBucket][] = [
      ['burst', b.burst],
      ['per_hour', b.hour],
    ];
    if (kind === 'write') applicable.push(['writes_per_minute', b.writes]);
    if (pdf) applicable.push(['pdf_per_minute', b.pdfMinute], ['pdf_per_day', b.pdfDay]);
    const quota = (bucket: TokenBucket) => ({ remaining: bucket.remaining(), reset: bucket.resetSeconds() });
    if (c.fail_next > 0) {
      c.fail_next--;
      return { ok: false, limit: 'simulated', message: this.message('simulated', c.retry_after), retryAfter: c.retry_after, quota: quota(b.burst) };
    }
    for (const [name, bucket] of applicable) {
      if (!bucket.canTake()) {
        const retryAfter = Math.max(1, bucket.waitSeconds());
        return { ok: false, limit: name, message: this.message(name, retryAfter), retryAfter, quota: quota(bucket) };
      }
    }
    for (const [, bucket] of applicable) bucket.take();
    const closest = applicable.map(([, bk]) => bk).reduce((m, bk) => (bk.remaining() < m.remaining() ? bk : m));
    return { ok: true, ...quota(closest) };
  }

  private message(limit: McpLimitName, retryAfter: number): string {
    return `Rate limit exceeded: ${LIMIT_TEXT[limit](this.config)}. Retry after ${retryAfter} seconds.`;
  }

  /** In-flight slot per credential; returns a release function, or null when all slots are taken. */
  acquire(credential: string): (() => void) | null {
    const n = this.inFlight.get(credential) ?? 0;
    if (n >= this.config.max_in_flight) return null;
    this.inFlight.set(credential, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const m = (this.inFlight.get(credential) ?? 1) - 1;
      if (m <= 0) this.inFlight.delete(credential);
      else this.inFlight.set(credential, m);
    };
  }

  inFlightMessage(): string {
    return this.message('max_in_flight', 1);
  }

  reconfigure(patch: Partial<McpRateLimitConfig>): void {
    Object.assign(this.config, patch);
    // bucket sizes changed: start every user afresh with the new limits
    this.users.clear();
  }

  reset(): void {
    this.users.clear();
    this.inFlight.clear();
    this.config.fail_next = 0;
  }
}
