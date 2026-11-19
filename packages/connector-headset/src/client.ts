/**
 * Minimal client for the Headset-style retail analytics API served by `apps/headset-mock`.
 * The API shape is OUR OWN, inspired by Headset (whose real API is partner-only), not their contract.
 * Responses are validated with zod at the boundary.
 */
import { z } from 'zod';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HeadsetClientConfig {
  baseUrl: string;
  token: string;
  fetch?: FetchLike;
}

export class HeadsetApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly url: string,
  ) {
    super(`Headset API ${status} ${code}: ${message} (${url})`);
    this.name = 'HeadsetApiError';
  }
}

const ErrorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

const page = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item), next_cursor: z.string().nullable(), total: z.number() });

export const StoreSchema = z.object({ id: z.string(), name: z.string(), city: z.string(), state: z.string() });
export type Store = z.infer<typeof StoreSchema>;

export const ProductSchema = z.object({ sku: z.string(), name: z.string(), brand: z.string(), category: z.string() });
export type Product = z.infer<typeof ProductSchema>;

export const WeekRowSchema = z.object({
  week_start: z.string(),
  units: z.number(),
  revenue: z.number(),
  avg_retail_price: z.number().nullable(),
  days_on_shelf: z.number(),
  oos_days: z.number(),
});
export const SellThroughRowSchema = z.object({ sku: z.string(), product_name: z.string(), store_id: z.string(), store_name: z.string(), weeks: z.array(WeekRowSchema) });
export type SellThroughRow = z.infer<typeof SellThroughRowSchema>;

export const TrendRowSchema = z.object({
  sku: z.string(),
  product_name: z.string(),
  has_data: z.boolean(),
  units_last_4w: z.number(),
  units_prior_4w: z.number(),
  wow_pct: z.number().nullable(),
  growth_3w_pct: z.number().nullable(),
  units_wow_pct: z.number().nullable(),
  units_growth_3w_pct: z.number().nullable(),
  stores_carrying: z.number(),
  stores_carrying_4w_ago: z.number(),
  oos_days_last_3w: z.number(),
  oos_days_prior_3w: z.number(),
  weekly: z.array(z.object({ week_start: z.string(), units: z.number(), revenue: z.number(), stores_carrying: z.number(), oos_days: z.number() })),
});
export type TrendRow = z.infer<typeof TrendRowSchema>;

export const MoverSchema = z.object({
  sku: z.string(),
  product_name: z.string(),
  units: z.number(),
  prior_units: z.number(),
  change_pct: z.number(),
  direction: z.enum(['up', 'down']),
  stores_carrying: z.number(),
  oos_days: z.number(),
});
export type Mover = z.infer<typeof MoverSchema>;

const SellThroughPage = page(SellThroughRowSchema).extend({ week_starts: z.array(z.string()) });
const TrendsPage = page(TrendRowSchema).extend({ latest_week: z.string().optional() });
const MoversBody = z.object({ data: z.array(MoverSchema), window: z.string(), latest_week: z.string().optional() });

export interface HeadsetClient {
  listStores(): Promise<Store[]>;
  /** Cheap probe: one page of stores + total. */
  probe(): Promise<{ stores: number }>;
  listProducts(): Promise<Product[]>;
  sellThrough(q: { skus: string[]; storeIds?: string[]; weeks: number }): Promise<{ weekStarts: string[]; rows: SellThroughRow[] }>;
  trends(q: { skus: string[]; weeks?: number }): Promise<{ latestWeek: string | null; rows: TrendRow[] }>;
  topMovers(q: { window: '7d' | '28d'; direction?: 'up' | 'down' | 'both'; limit: number }): Promise<{ latestWeek: string | null; rows: Mover[] }>;
}

export function createHeadsetClient(config: HeadsetClientConfig): HeadsetClient {
  const base = config.baseUrl.replace(/\/+$/, '');
  const doFetch: FetchLike = config.fetch ?? ((url, init) => fetch(url, init));

  async function get<T>(path: string, params: Array<[string, string]>, schema: z.ZodType<T>): Promise<T> {
    const qs = new URLSearchParams(params).toString();
    const url = `${base}${path}${qs ? `?${qs}` : ''}`;
    const res = await doFetch(url, { headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' } });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const e = ErrorBody.safeParse(body);
      throw new HeadsetApiError(res.status, e.success ? e.data.error.code : 'http_error', e.success ? e.data.error.message : res.statusText, url);
    }
    return schema.parse(body);
  }

  /** Follows next_cursor until exhausted. */
  async function all<P extends { data: unknown[]; next_cursor: string | null }>(
    path: string,
    params: Array<[string, string]>,
    schema: z.ZodType<P>,
  ): Promise<{ first: P; items: P['data'] }> {
    const first = await get(path, [...params, ['limit', '200']], schema);
    const items: P['data'] = [...first.data];
    let cursor = first.next_cursor;
    while (cursor) {
      const next = await get(path, [...params, ['limit', '200'], ['cursor', cursor]], schema);
      items.push(...next.data);
      cursor = next.next_cursor;
    }
    return { first, items };
  }

  const arr = (name: string, values: readonly string[] = []): Array<[string, string]> => values.map((v) => [`${name}[]`, v]);

  return {
    listStores: async () => (await all('/v1/stores', [], page(StoreSchema))).items,
    probe: async () => ({ stores: (await get('/v1/stores', [['limit', '1']], page(StoreSchema))).total }),
    listProducts: async () => (await all('/v1/products', [], page(ProductSchema))).items,
    sellThrough: async ({ skus, storeIds, weeks }) => {
      const { first, items } = await all('/v1/sell-through', [...arr('skus', skus), ...arr('store_ids', storeIds), ['weeks', String(weeks)]], SellThroughPage);
      return { weekStarts: first.week_starts, rows: items };
    },
    trends: async ({ skus, weeks }) => {
      const { first, items } = await all('/v1/trends', [...arr('skus', skus), ...(weeks ? [['weeks', String(weeks)] as [string, string]] : [])], TrendsPage);
      return { latestWeek: first.latest_week ?? null, rows: items };
    },
    topMovers: async ({ window, direction = 'both', limit }) => {
      const body = await get('/v1/top-movers', [['window', window], ['direction', direction], ['limit', String(limit)]], MoversBody);
      return { latestWeek: body.latest_week ?? null, rows: body.data };
    },
  };
}

export const DEFAULT_HEADSET_BASE_URL = 'http://localhost:4600';
export const DEFAULT_HEADSET_TOKEN = 'headset-mock-token';

/** From `HEADSET_BASE_URL` (default the local mock) and `HEADSET_API_TOKEN` (default the mock token). */
export function createHeadsetClientFromEnv(env: Record<string, string | undefined> = process.env, overrides: Partial<HeadsetClientConfig> = {}): HeadsetClient {
  return createHeadsetClient({
    baseUrl: env.HEADSET_BASE_URL || DEFAULT_HEADSET_BASE_URL,
    token: env.HEADSET_API_TOKEN || DEFAULT_HEADSET_TOKEN,
    ...overrides,
  });
}
