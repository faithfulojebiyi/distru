/**
 * The email port. Two adapters ship with the connector:
 *
 * - `OutboxTransport`: in-memory mock outbox (default for local dev, tests and evals). Nothing leaves
 *   the process; `list()` shows what "was sent".
 * - `ResendTransport`: real delivery through Resend's HTTP API (fetch, no SDK).
 *
 * Both are idempotent on the harness key: sending twice with the same key returns the first
 * message instead of delivering a second email, and `findByIdempotencyKey` finds it.
 */
import { z } from 'zod';

export const OutgoingEmailSchema = z.object({
  from: z.string().min(1),
  to: z.array(z.email()).min(1),
  cc: z.array(z.email()),
  subject: z.string().min(1),
  text: z.string(),
  html: z.string(),
});
export type OutgoingEmail = z.infer<typeof OutgoingEmailSchema>;

export interface SentEmail extends OutgoingEmail {
  messageId: string;
  idempotencyKey: string;
  sentAt: string;
}

export interface EmailTransport {
  /** Human-readable adapter name (`outbox`, `resend`) for health and the UI. */
  readonly name: string;
  /** Deliver `msg`. Must not deliver twice for the same `idempotencyKey`. */
  send(msg: OutgoingEmail & { idempotencyKey: string }): Promise<{ messageId: string }>;
  /** The message previously sent with this key, if any. */
  findByIdempotencyKey(idempotencyKey: string): Promise<SentEmail | null>;
  /** A sent message by provider id, or null when unknown. */
  get(messageId: string): Promise<SentEmail | null>;
  /** Most recent messages first (for the `outbox_recent` tool). */
  list?(limit: number): Promise<SentEmail[]>;
}

// ── Outbox (mock) ───────────────────────────────────────────────────────────────────────────

export interface OutboxOptions {
  now?: () => Date;
  ids?: () => string;
  /**
   * Where "sent" messages are kept (key → message). Default: in memory. Back it with a table so the
   * outbox (and `findByIdempotencyKey`, the executor's dedupe) survives restarts.
   */
  record?: SentEmailRecord;
}

/** Mock outbox: nothing leaves the process. `deliveries` counts real deliveries (a deduplicated send does not count). */
export class OutboxTransport implements EmailTransport {
  readonly name = 'outbox';
  readonly #record: SentEmailRecord;
  readonly #now: () => Date;
  readonly #ids: () => string;
  /** Calls to `send` (including deduplicated ones). */
  sendCalls = 0;
  /** Messages actually added to the outbox. */
  deliveries = 0;

  constructor(options: OutboxOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#record = options.record ?? new InMemorySentEmailRecord();
    // Random by default, so ids stay unique across restarts when the record is persistent.
    let n = 0;
    this.#ids = options.ids ?? (options.record ? () => `outbox_${crypto.randomUUID()}` : () => `outbox_${++n}`);
  }

  async send(msg: OutgoingEmail & { idempotencyKey: string }): Promise<{ messageId: string }> {
    this.sendCalls++;
    const existing = await this.#record.byKey(msg.idempotencyKey);
    if (existing) return { messageId: existing.messageId };
    const sent: SentEmail = { ...OutgoingEmailSchema.parse(msg), idempotencyKey: msg.idempotencyKey, messageId: this.#ids(), sentAt: this.#now().toISOString() };
    await this.#record.put(sent);
    this.deliveries++;
    return { messageId: sent.messageId };
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<SentEmail | null> {
    const m = await this.#record.byKey(idempotencyKey);
    return m ? structuredClone(m) : null;
  }

  async get(messageId: string): Promise<SentEmail | null> {
    const m = await this.#record.byId(messageId);
    return m ? structuredClone(m) : null;
  }

  async list(limit = 50): Promise<SentEmail[]> {
    return (await this.#record.recent(limit)).map((m) => structuredClone(m));
  }
}

// ── Resend ──────────────────────────────────────────────────────────────────────────────────

export class ResendApiError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;
  /** Resend error name, e.g. `concurrent_idempotent_requests`, `validation_error`. */
  readonly code: string | undefined;
  constructor(status: number, message: string, retryAfterSeconds?: number, code?: string) {
    super(`Resend ${status}: ${message}`);
    this.name = 'ResendApiError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.code = code;
  }
}

/**
 * Where Resend sends are recorded locally (key → message), so `findByIdempotencyKey` works without
 * a provider search API. Default: in memory. Production: back it with a table.
 */
export interface SentEmailRecord {
  put(message: SentEmail): Promise<void>;
  byKey(idempotencyKey: string): Promise<SentEmail | null>;
  byId(messageId: string): Promise<SentEmail | null>;
  recent(limit: number): Promise<SentEmail[]>;
}

export class InMemorySentEmailRecord implements SentEmailRecord {
  readonly #rows: SentEmail[] = [];
  async put(message: SentEmail): Promise<void> {
    const i = this.#rows.findIndex((r) => r.idempotencyKey === message.idempotencyKey);
    if (i >= 0) this.#rows[i] = message;
    else this.#rows.push(message);
  }
  async byKey(key: string): Promise<SentEmail | null> {
    return this.#rows.find((r) => r.idempotencyKey === key) ?? null;
  }
  async byId(id: string): Promise<SentEmail | null> {
    return this.#rows.find((r) => r.messageId === id) ?? null;
  }
  async recent(limit: number): Promise<SentEmail[]> {
    return this.#rows.slice(-limit).reverse();
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ResendOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  record?: SentEmailRecord;
  now?: () => Date;
}

const ResendSendResponse = z.object({ id: z.string() });
const ResendEmailResponse = z.object({
  id: z.string(),
  from: z.string(),
  to: z.union([z.array(z.string()), z.string()]),
  cc: z.union([z.array(z.string()), z.string()]).nullish(),
  subject: z.string(),
  text: z.string().nullish(),
  html: z.string().nullish(),
  created_at: z.string(),
});
const ResendErrorBody = z.object({ message: z.string().optional(), name: z.string().optional() });
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
const asList = (v: string[] | string | null | undefined): string[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

/**
 * Resend over fetch. Idempotency is twofold: Resend's `Idempotency-Key` header (the provider
 * refuses to deliver twice for 24 h, returning the first id) plus a local `SentEmailRecord` so the
 * harness can find a prior send without a provider search API.
 */
export class ResendTransport implements EmailTransport {
  readonly name = 'resend';
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #record: SentEmailRecord;
  readonly #now: () => Date;

  constructor(options: ResendOptions) {
    if (!options.apiKey) throw new Error('ResendTransport needs an apiKey (RESEND_API_KEY)');
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? 'https://api.resend.com').replace(/\/$/, '');
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#record = options.record ?? new InMemorySentEmailRecord();
    this.#now = options.now ?? (() => new Date());
  }

  async #request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<unknown> {
    const res = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.#apiKey}`, 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) {
      const retryAfter = Number(res.headers.get('retry-after'));
      let message = text.slice(0, 300);
      let code: string | undefined;
      const parsed = ResendErrorBody.safeParse(safeJson(text));
      if (parsed.success) {
        message = parsed.data.message ?? message;
        code = parsed.data.name;
      }
      throw new ResendApiError(res.status, message, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined, code);
    }
    return text ? JSON.parse(text) : null;
  }

  async send(msg: OutgoingEmail & { idempotencyKey: string }): Promise<{ messageId: string }> {
    const { idempotencyKey, ...email } = msg;
    const body = {
      ...email,
      ...(email.cc.length ? {} : { cc: undefined }),
      headers: { 'X-Ops-Idempotency-Key': idempotencyKey },
      tags: [{ name: 'ops_idem', value: idempotencyKey.replace(/[^A-Za-z0-9_-]/g, '_') }],
    };
    const { id } = ResendSendResponse.parse(await this.#request('POST', '/emails', body, { 'Idempotency-Key': idempotencyKey }));
    await this.#record.put({ ...email, idempotencyKey, messageId: id, sentAt: this.#now().toISOString() });
    return { messageId: id };
  }

  findByIdempotencyKey(idempotencyKey: string): Promise<SentEmail | null> {
    return this.#record.byKey(idempotencyKey);
  }

  async get(messageId: string): Promise<SentEmail | null> {
    let raw: unknown;
    try {
      raw = await this.#request('GET', `/emails/${encodeURIComponent(messageId)}`);
    } catch (err) {
      if (err instanceof ResendApiError && err.status === 404) return null;
      throw err;
    }
    const e = ResendEmailResponse.parse(raw);
    const local = await this.#record.byId(messageId);
    return {
      messageId: e.id,
      from: e.from,
      to: asList(e.to),
      cc: asList(e.cc),
      subject: e.subject,
      text: e.text ?? '',
      html: e.html ?? '',
      sentAt: e.created_at,
      idempotencyKey: local?.idempotencyKey ?? '',
    };
  }

  list(limit: number): Promise<SentEmail[]> {
    return this.#record.recent(limit);
  }
}

/**
 * Resend 429 / 5xx and 409 `concurrent_idempotent_requests` are transient. 409
 * `invalid_idempotent_request` (same key, different body) is not: retrying cannot fix it.
 */
export function isRetryableEmailError(err: unknown): boolean {
  if (!(err instanceof ResendApiError)) return false;
  if (err.status === 409) return err.code === 'concurrent_idempotent_requests';
  return err.status === 429 || err.status >= 500;
}
