import * as operations from './generated/distru';
import { distruRequest, type DistruClientConfig, type DistruRequestOptions } from './mutator';

/** Any Distru list response: `{ data: T[], next_page: string | null }`. */
export interface Page<T> {
  data?: T[] | null;
  next_page?: string | null;
}

/** A list operation, bound or unbound: `(params, options?) => Promise<Page<T>>`. */
export type ListOperation<P, T> = (params: P, options?: DistruRequestOptions) => Promise<Page<T>>;

export interface PaginateOptions {
  /** Stop after this many pages (safety valve). Default 1000. */
  maxPages?: number;
  /** Stop after this many items have been yielded. */
  limit?: number;
  signal?: AbortSignal;
}

type Operations = typeof operations;
type OperationName = {
  [K in keyof Operations]: K extends `get${string}Url` ? never : Operations[K] extends (...args: never[]) => Promise<unknown> ? K : never;
}[keyof Operations];

/** Every generated operation, with the client's config already bound. Same signatures as the generated ones. */
export type BoundOperations = { [K in OperationName]: Operations[K] };

const isOperationName = (name: string): name is OperationName =>
  typeof (operations as Record<string, unknown>)[name] === 'function' && !/^get.+Url$/.test(name);

/**
 * Binds the config into the trailing `options` argument of a generated operation. Orval always puts
 * `options` last, so `fn.length - 1` is its index regardless of optional params before it.
 */
function bind<F extends (...args: never[]) => unknown>(fn: F, config: DistruClientConfig): F {
  const optionsIndex = fn.length - 1;
  const bound = (...args: unknown[]) => {
    const padded = args.slice(0, optionsIndex);
    while (padded.length < optionsIndex) padded.push(undefined);
    const options = (args[optionsIndex] ?? {}) as DistruRequestOptions;
    padded.push({ ...options, distru: options.distru ?? config });
    return (fn as unknown as (...a: unknown[]) => unknown)(...padded);
  };
  Object.defineProperty(bound, 'name', { value: fn.name });
  return bound as unknown as F;
}

/**
 * Creates a Distru API client. No globals: two clients with different tokens can coexist.
 *
 * ```ts
 * const distru = createDistruClient({ baseUrl: 'http://localhost:4500', token: 'mock-token' });
 * const { data: rows } = await distru.getInventoryVelocityReport({ below_reorder_point: true, lead_time_days: 14 });
 * for await (const p of distru.paginate(distru.listProducts, { is_active: true })) console.log(p.sku);
 * ```
 */
export function createDistruClient(config: DistruClientConfig) {
  const bound = {} as Record<OperationName, unknown>;
  for (const name of Object.keys(operations)) {
    if (isOperationName(name)) bound[name] = bind(operations[name] as (...args: never[]) => unknown, config);
  }
  const ops = bound as BoundOperations;

  /** Raw request against a path or an absolute Distru URL (used to follow `next_page`). */
  const request = <T>(url: string, init?: RequestInit) => distruRequest<T>(config, url, init);

  /** Yields whole pages, following `next_page` exactly as given until it is null. */
  async function* pages<P, T>(op: ListOperation<P, T>, params: P, opts: PaginateOptions = {}): AsyncGenerator<Page<T>> {
    const maxPages = opts.maxPages ?? 1000;
    let page = await op(params, { distru: config, signal: opts.signal });
    for (let n = 1; ; n++) {
      yield page;
      const next = page.next_page;
      if (!next) return;
      if (n >= maxPages) throw new Error(`paginate: exceeded maxPages (${maxPages}) — next_page=${next}`);
      page = await request<Page<T>>(next, { method: 'GET', signal: opts.signal });
    }
  }

  /** Yields every item across pages. `for await (const x of client.paginate(client.listProducts, {...}))` */
  async function* paginate<P, T>(op: ListOperation<P, T>, params: P, opts: PaginateOptions = {}): AsyncGenerator<T> {
    if (opts.limit !== undefined && opts.limit <= 0) return;
    let count = 0;
    for await (const page of pages(op, params, opts)) {
      for (const item of page.data ?? []) {
        yield item;
        if (opts.limit !== undefined && ++count >= opts.limit) return;
      }
    }
  }

  /** Collects every item across pages into an array. */
  async function listAll<P, T>(op: ListOperation<P, T>, params: P, opts: PaginateOptions = {}): Promise<T[]> {
    const out: T[] = [];
    for await (const item of paginate(op, params, opts)) out.push(item);
    return out;
  }

  return { ...ops, config, request, pages, paginate, listAll };
}

export type DistruClient = ReturnType<typeof createDistruClient>;

/** Builds a client from env: DISTRU_BASE_URL (default http://localhost:4500) and DISTRU_API_TOKEN. */
export function createDistruClientFromEnv(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<DistruClientConfig> = {},
): DistruClient {
  const token = env.DISTRU_API_TOKEN ?? env.DISTRU_MOCK_TOKEN ?? 'mock-token';
  return createDistruClient({ baseUrl: env.DISTRU_BASE_URL ?? 'http://localhost:4500', token, ...overrides });
}
