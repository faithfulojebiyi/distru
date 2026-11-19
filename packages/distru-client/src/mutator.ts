/**
 * Orval mutator: every generated operation funnels through `distruFetch`.
 *
 * There is no global configuration. The connection settings (`DistruClientConfig`) travel with each
 * call in the request options under `distru`; `createDistruClient()` binds them for you, so callers
 * normally never touch this file directly.
 */

import { ARRAY_QUERY_PARAMS } from './array-params.gen';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface DistruClientConfig {
  /** `https://app.distru.com` (a trailing `/public/v1` is tolerated) or e.g. `http://localhost:4500`. */
  baseUrl: string;
  /** Distru API token (sent as `Authorization: Bearer <token>`). */
  token: string;
  /** Injected fetch, for tests / instrumentation. Defaults to global `fetch`. */
  fetch?: FetchLike;
  /** Retries after a 429 before giving up. Default 3. */
  maxRetries?: number;
  /** Longest single Retry-After wait we are willing to honour, in ms. Default 30_000. */
  maxRetryDelayMs?: number;
  /** Wait used when a 429 carries no (parsable) Retry-After, in ms. Default 1_000. */
  defaultRetryDelayMs?: number;
  /** Injected sleep, for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Extra headers on every request (e.g. a request id). */
  headers?: Record<string, string>;
}

/** Extra request option understood by the mutator. */
export interface DistruRequestOptions extends RequestInit {
  distru?: DistruClientConfig;
}

/** One entry of Distru's error envelope `{ errors: [{ message, pointer }] }`. */
export interface DistruErrorItem {
  message: string;
  /** Path to the offending request field, e.g. `["items", 0, "quantity"]`; `["base"]` = whole request. */
  pointer: (string | number)[];
}

export class DistruApiError extends Error {
  override readonly name = 'DistruApiError';
  constructor(
    /** HTTP status (400, 401, 403, 404, 429, or anything unexpected). */
    readonly status: number,
    readonly errors: DistruErrorItem[],
    readonly method: string,
    readonly url: string,
    /** Seconds from Retry-After on a 429, when present. */
    readonly retryAfterSeconds?: number,
    /** Raw body when it was not a Distru error envelope. */
    readonly body?: unknown,
  ) {
    super(
      `Distru ${method} ${safePath(url)} failed with ${status}: ` +
        (errors.length ? errors.map(formatErrorItem).join('; ') : 'no error details'),
    );
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
  get isValidationError(): boolean {
    return this.status === 400;
  }
  /** Errors whose pointer starts with the given path, e.g. `errorsAt('items', 0)`. */
  errorsAt(...path: (string | number)[]): DistruErrorItem[] {
    return this.errors.filter((e) => path.every((p, i) => e.pointer[i] === p));
  }
}

export function formatErrorItem(e: DistruErrorItem): string {
  const at = e.pointer.length && !(e.pointer.length === 1 && e.pointer[0] === 'base') ? ` (at ${e.pointer.join('.')})` : '';
  return `${e.message}${at}`;
}

function safePath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parses `{ errors: [{ message, pointer }] }`; returns null when the body is not that shape. */
export function parseErrorEnvelope(body: unknown): DistruErrorItem[] | null {
  if (!isRecord(body) || !Array.isArray(body.errors)) return null;
  return body.errors.map((e): DistruErrorItem => {
    if (!isRecord(e)) return { message: String(e), pointer: ['base'] };
    const pointer = Array.isArray(e.pointer)
      ? e.pointer.filter((p): p is string | number => typeof p === 'string' || typeof p === 'number')
      : ['base'];
    return { message: typeof e.message === 'string' ? e.message : JSON.stringify(e.message), pointer };
  });
}

/** Retry-After is either delta-seconds or an HTTP-date. Returns seconds, or undefined. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value == null || value.trim() === '') return undefined;
  const n = Number(value);
  if (Number.isFinite(n)) return Math.max(0, n);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * Generated operations take array params without brackets (`{ ids: ['a'] }` → `ids=a`); Distru wants
 * `ids[]=a`. Rewrites known array keys on generated (relative) URLs only — `next_page` URLs are
 * absolute and are always sent exactly as given.
 */
export function bracketArrayParams(url: string): string {
  const q = url.indexOf('?');
  if (q < 0 || /^https?:\/\//i.test(url)) return url;
  const params = new URLSearchParams(url.slice(q + 1));
  const out = new URLSearchParams();
  for (const [k, v] of params) out.append(ARRAY_QUERY_PARAMS.has(k) ? `${k}[]` : k, v);
  return `${url.slice(0, q)}?${out.toString().replace(/%5B%5D=/g, '[]=')}`;
}

/** Resolves a generated path (`/public/v1/products?...`) or an absolute `next_page` URL. */
export function resolveUrl(baseUrl: string, url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const base = baseUrl.replace(/\/+$/, '').replace(/\/public\/v1$/, '');
  return `${base}${url.startsWith('/') ? '' : '/'}${url}`;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Low-level request: auth headers, JSON encoding, error envelope → `DistruApiError`, 429 retries.
 * Returns the parsed JSON body (or undefined for an empty body).
 */
export async function distruRequest<T>(config: DistruClientConfig, url: string, init: RequestInit = {}): Promise<T> {
  const doFetch = config.fetch ?? ((input: string, i?: RequestInit) => fetch(input, i));
  const sleep = config.sleep ?? defaultSleep;
  const maxRetries = config.maxRetries ?? 3;
  const maxDelay = config.maxRetryDelayMs ?? 30_000;
  const fallbackDelay = config.defaultRetryDelayMs ?? 1_000;

  const fullUrl = resolveUrl(config.baseUrl, bracketArrayParams(url));
  const baseOrigin = new URL(resolveUrl(config.baseUrl, '/')).origin;
  if (new URL(fullUrl).origin !== baseOrigin) {
    // Never send the token to a host other than the configured Distru base URL.
    throw new Error(`Refusing to call ${new URL(fullUrl).origin}: not the configured Distru origin ${baseOrigin}`);
  }
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${config.token}`);
  headers.set('Accept', 'application/json');
  if (init.body != null && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(config.headers ?? {})) headers.set(k, v);

  for (let attempt = 0; ; attempt++) {
    const res = await doFetch(fullUrl, { ...init, method, headers });
    const text = await res.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (res.ok) return body as T;

    const retryAfter = res.status === 429 ? parseRetryAfter(res.headers.get('Retry-After')) : undefined;
    if (res.status === 429 && attempt < maxRetries) {
      const waitMs = retryAfter !== undefined ? retryAfter * 1000 : fallbackDelay;
      if (waitMs <= maxDelay) {
        await sleep(waitMs);
        continue;
      }
    }
    const errors = parseErrorEnvelope(body);
    throw new DistruApiError(
      res.status,
      errors ?? [{ message: typeof body === 'string' && body ? body : res.statusText || `HTTP ${res.status}`, pointer: ['base'] }],
      method,
      fullUrl,
      retryAfter,
      errors ? undefined : body,
    );
  }
}

/** Orval mutator entry point. */
export async function distruFetch<T>(url: string, options: DistruRequestOptions = {}): Promise<T> {
  const { distru, ...init } = options;
  if (!distru) {
    throw new Error('Distru client not configured: call operations through createDistruClient({ baseUrl, token })');
  }
  return distruRequest<T>(distru, url, init);
}

export default distruFetch;
