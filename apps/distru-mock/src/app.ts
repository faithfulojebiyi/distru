/**
 * Mock of Distru's public REST API (`/public/v1/...`), schema-faithful to docs.distru.com/openapi.json
 * for the endpoints the Ops Agent uses, plus `/__mock/*` control endpoints.
 */
import { Hono, type Context } from 'hono';
import { recordHistory, serializeActivity } from './history';
import { createMcpRoute, type McpMockOptions } from './mcp/server';
import { isOnMenu, menuOrderErrors } from './menus';
import { Ops } from './ops';
import {
  DEFAULT_MCP_LIMIT,
  DEFAULT_PDF_LIMIT,
  DEFAULT_REST_LIST_LIMIT,
  McpRateLimiter,
  RestRateLimiter,
  type Clock,
  type McpRateLimitConfig,
  type PdfLimitConfig,
  type RestListLimitConfig,
} from './ratelimit';
import { isScenario, SCENARIOS, seedStore, type ScenarioName } from './seed';
import { Serializer } from './serialize';
import type { Store } from './store';
import type { LotRec, OrderRec, ProductRec, PurchaseRec } from './types';
import type { ApiErrorItem } from './upsert';
import { inventoryVelocityReport } from './velocity';
import { WebhookDispatcher, type WebhookType } from './webhooks';

export interface RateLimitConfig {
  /** the next N /public/v1 requests get a 429 */
  fail_next: number;
  /** every Nth /public/v1 request gets a 429 (0 = off) */
  every: number;
  /** Retry-After seconds on simulated 429s */
  retry_after: number;
  /** Distru's list budget (token bucket); `tokens` in /__mock/config sets the current balance */
  list: RestListLimitConfig;
  /** PDF downloads: per account, sliding windows */
  pdf: PdfLimitConfig;
}

export interface MockOptions {
  token?: string;
  scenario?: ScenarioName;
  /** anchor date for the seed (defaults to now) */
  now?: Date | string;
  pageSize?: number;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookFetch?: (url: string, init: RequestInit) => Promise<Response>;
  webhookRetryDelaysMs?: number[];
  rateLimit?: Partial<Omit<RateLimitConfig, 'list' | 'pdf'>> & { list?: Partial<RestListLimitConfig>; pdf?: Partial<PdfLimitConfig> };
  /** MCP per-user limits (defaults: Distru's documented limits) */
  mcpRateLimit?: Partial<McpRateLimitConfig>;
  /** MCP auth: exact key to require; default accepts any `Bearer distru_mcp_*` */
  mcpKey?: string;
  /** base used in next_page URLs; defaults to the request origin */
  publicUrl?: string;
  /** clock for rate limiting (ms since epoch); default Date.now */
  clock?: Clock;
}

const err = (c: Context, status: 400 | 401 | 403 | 404 | 429, errors: ApiErrorItem[]) => c.json({ errors }, status);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const notFound = (c: Context, what = 'Not Found') => err(c, 404, [{ message: what, pointer: ['base'] }]);

/** Query-string reader that records Distru-style validation errors. */
class Query {
  readonly errors: ApiErrorItem[] = [];
  readonly sp: URLSearchParams;
  constructor(url: string) {
    this.sp = new URL(url).searchParams;
  }
  str(name: string): string | undefined {
    const v = this.sp.get(name);
    return v === null || v === '' ? undefined : v;
  }
  arr(name: string): string[] | undefined {
    const v = this.sp.getAll(`${name}[]`).filter((x) => x !== '');
    if (v.length > 200) this.errors.push({ message: 'accepts at most 200 values', pointer: [name] });
    return v.length ? v : undefined;
  }
  enumArr<T extends string>(name: string, allowed: readonly T[]): T[] | undefined {
    const v = this.arr(name);
    for (const x of v ?? []) if (!allowed.includes(x as T)) this.errors.push({ message: `contains an invalid value "${x}"; allowed: ${allowed.join(', ')}`, pointer: [name] });
    return v as T[] | undefined;
  }
  bool(name: string): boolean | undefined {
    const v = this.str(name);
    if (v === undefined) return undefined;
    if (v === 'true') return true;
    if (v === 'false') return false;
    this.errors.push({ message: 'must be true or false', pointer: [name] });
    return undefined;
  }
  int(name: string, min: number, max: number): number | undefined {
    const v = this.str(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) {
      this.errors.push({ message: `must be an integer from ${min} to ${max}`, pointer: [name] });
      return undefined;
    }
    return n;
  }
  /** `min,max` inclusive datetime range; either side optional. */
  range(name: string): ((iso: string | null | undefined) => boolean) | undefined {
    const v = this.str(name);
    if (v === undefined) return undefined;
    const [a = '', b = ''] = v.split(',');
    const parse = (s: string) => (s.trim() === '' ? null : Date.parse(s.trim()));
    const min = parse(a);
    const max = parse(b);
    if ((min !== null && Number.isNaN(min)) || (max !== null && Number.isNaN(max)) || v.split(',').length > 2) {
      this.errors.push({ message: 'must be an ISO8601 range "min,max" (either side optional)', pointer: [name] });
      return undefined;
    }
    return (iso) => {
      if (!iso) return false;
      const t = Date.parse(iso);
      return (min === null || t >= min) && (max === null || t <= max);
    };
  }
}

const encodeCursor = (offset: number) => Buffer.from(`o:${offset}`).toString('base64url');
const decodeCursor = (cursor: string): number | null => {
  const m = /^o:(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString());
  return m ? Number(m[1]) : null;
};

export function createMockServer(opts: MockOptions = {}) {
  const token = opts.token ?? 'mock-token';
  const pageSize = opts.pageSize ?? 25;
  const anchor = () => (opts.now ? new Date(opts.now) : new Date());
  const clock: Clock = opts.clock ?? (() => Date.now());
  const { list: listOpt, pdf: pdfOpt, ...legacyRl } = opts.rateLimit ?? {};
  const restLimiter = new RestRateLimiter({ ...DEFAULT_REST_LIST_LIMIT, ...listOpt }, { ...DEFAULT_PDF_LIMIT, ...pdfOpt }, clock);
  const mcpLimiter = new McpRateLimiter({ ...DEFAULT_MCP_LIMIT, ...opts.mcpRateLimit }, clock);
  const state = {
    scenario: (opts.scenario ?? 'default') as ScenarioName,
    store: seedStore(opts.scenario ?? 'default', anchor()),
    rateLimit: { fail_next: 0, every: 0, retry_after: 2, ...legacyRl, list: restLimiter.config, pdf: restLimiter.pdf } as RateLimitConfig,
    requests: 0,
    metrc: { fail_next: 0 },
  };
  let ser = new Serializer(state.store);
  const resolveWebhookObject = (type: WebhookType, id: string): unknown => {
    const s = state.store;
    switch (type) {
      case 'ORDER': {
        const o = s.orders.get(id);
        return o ? ser.order(o) : null;
      }
      case 'PURCHASE': {
        const p = s.purchases.get(id);
        return p ? ser.purchase(p) : null;
      }
      case 'PRODUCT': {
        const p = s.products.get(id);
        return p ? ser.product(p) : null;
      }
      case 'PACKAGE': {
        const l = s.lots.get(id);
        return l ? ser.package(l) : null;
      }
      case 'COMPANY': {
        const co = s.companies.get(id);
        return co ? ser.company(co) : null;
      }
      default:
        return null;
    }
  };
  const webhooks = new WebhookDispatcher(
    () => state.store,
    {
      url: opts.webhookUrl,
      secret: opts.webhookSecret ?? 'mock-webhook-secret',
      fetch: opts.webhookFetch,
      retryDelaysMs: opts.webhookRetryDelaysMs,
    },
    resolveWebhookObject,
  );
  const ops = new Ops({ store: () => state.store, ser: () => ser, webhooks, metrc: state.metrc });
  const reset = (scenario: ScenarioName = state.scenario, now?: Date) => {
    state.scenario = scenario;
    state.store = seedStore(scenario, now ?? anchor());
    ser = new Serializer(state.store);
    restLimiter.reset();
    mcpLimiter.reset();
    state.metrc.fail_next = 0;
  };
  const S = () => state.store;

  /** Paginate an already-filtered list; next_page carries the original filters + page[after]. */
  function page<T, U>(c: Context, items: T[], map: (t: T) => U, size = pageSize) {
    const url = new URL(c.req.url);
    const cursor = url.searchParams.get('page[after]');
    let offset = 0;
    if (cursor !== null) {
      const o = decodeCursor(cursor);
      if (o === null) return err(c, 400, [{ message: 'is not a valid page cursor', pointer: ['page'] }]);
      offset = o;
    }
    const slice = items.slice(offset, offset + size);
    let next_page: string | null = null;
    if (offset + size < items.length) {
      const kept = url.search
        .replace(/^\?/, '')
        .split('&')
        .filter((kv) => kv && !/^page(\[|%5B)after(\]|%5D)=/i.test(kv));
      kept.push(`page[after]=${encodeCursor(offset + size)}`);
      next_page = `${opts.publicUrl ?? url.origin}${url.pathname}?${kept.join('&')}`;
    }
    return c.json({ data: slice.map(map), next_page });
  }

  const productOf = (lotOrId: LotRec | string): ProductRec | undefined => S().products.get(typeof lotOrId === 'string' ? lotOrId : lotOrId.product_id);

  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true, scenario: state.scenario }));

  // ── auth + rate limiting for the public API ─────────────────────────────────────────────────
  app.use('/public/v1/*', async (c, next) => {
    const auth = c.req.header('authorization');
    if (auth !== `Bearer ${token}`) return err(c, 401, [{ message: 'Missing or invalid API token', pointer: ['base'] }]);
    state.requests++;
    const rl = state.rateLimit;
    if (rl.fail_next > 0 || (rl.every > 0 && state.requests % rl.every === 0)) {
      if (rl.fail_next > 0) rl.fail_next--;
      c.header('Retry-After', String(rl.retry_after));
      return err(c, 429, [{ message: `Rate limit exceeded. Retry after ${rl.retry_after} seconds.`, pointer: ['base'] }]);
    }
    await next();
  });

  // ── Distru's list budget: token bucket over the paginated lists with an updated_datetime filter ──
  app.use('/public/v1/*', async (c, next) => {
    if (c.req.method !== 'GET' || !restLimiter.config.enabled) return next();
    const url = new URL(c.req.url);
    const kind = restLimiter.classify(url.pathname, url.searchParams);
    if (!kind.limited) return next();
    if (!kind.free && !restLimiter.bucket.take()) {
      const retryAfter = Math.max(1, restLimiter.bucket.waitSeconds());
      for (const [k, v] of Object.entries(restLimiter.headers())) c.header(k, v);
      c.header('Retry-After', String(retryAfter));
      const cfg = restLimiter.config;
      return err(c, 429, [
        {
          message: `List rate limit exceeded: ${cfg.capacity} calls per account, refilling at ${cfg.refill_per_minute} per minute. Calls with an updated_datetime lower bound within the last ${cfg.free_window_days} days are not limited. Retry after the Retry-After period.`,
          pointer: ['base'],
        },
      ]);
    }
    await next();
    for (const [k, v] of Object.entries(restLimiter.headers())) c.res.headers.set(k, v);
  });

  // ── reports ─────────────────────────────────────────────────────────────────────────────────
  app.get('/public/v1/reports/inventory-velocity', (c) => {
    const q = new Query(c.req.url);
    const params = {
      lead_time_days: q.int('lead_time_days', 1, 365),
      target_days_of_supply: q.int('target_days_of_supply', 1, 365),
      service_level: q.int('service_level', 50, 99),
      no_sales_after_days: q.int('no_sales_after_days', 0, 365),
      stale_incoming_days: q.int('stale_incoming_days', 1, 3650),
      max_days_of_supply: q.int('max_days_of_supply', 0, 36500),
      search: q.str('search'),
      below_reorder_point: q.bool('below_reorder_point'),
      below_quantity_available_threshold_min: q.bool('below_quantity_available_threshold_min'),
      product_ids: q.arr('product_ids'),
      location_ids: q.arr('location_ids'),
      statuses: q.enumArr('statuses', ['PENDING', 'PROCESSING', 'READY_TO_SHIP', 'DELIVERING', 'DELIVERED', 'COMPLETED', 'CANCELED'] as const),
      product_category_ids: q.arr('product_category_ids'),
      product_subcategory_ids: q.arr('product_subcategory_ids'),
      product_tag_ids: q.arr('product_tag_ids'),
      vendor_ids: q.arr('vendor_ids'),
      brand_ids: q.arr('brand_ids'),
      product_group_ids: q.arr('product_group_ids'),
    };
    q.arr('user_ids');
    if (q.errors.length) return err(c, 400, q.errors);
    return c.json(inventoryVelocityReport(S(), params));
  });

  // ── inventory ───────────────────────────────────────────────────────────────────────────────
  app.get('/public/v1/inventory', (c) => {
    const q = new Query(c.req.url);
    const groupings = q.enumArr('groupings', ['PRODUCT', 'LOCATION', 'BATCH_NUMBER'] as const);
    if (!groupings?.includes('PRODUCT')) q.errors.push({ message: 'is required and must include PRODUCT', pointer: ['groupings'] });
    const f = {
      product_ids: q.arr('product_ids'),
      location_ids: q.arr('location_ids'),
      batch_ids: q.arr('batch_ids'),
      category: q.arr('product_category_ids'),
      vendor: q.arr('product_vendor_ids'),
      skus: q.arr('product_skus'),
      strain: q.arr('product_strain_ids'),
      none: [q.arr('product_subcategory_ids'), q.arr('product_group_ids'), q.arr('product_brand_ids'), q.arr('product_tag_ids')].some(Boolean),
    };
    if (q.errors.length || !groupings) return err(c, 400, q.errors);
    const byBatch = groupings.includes('BATCH_NUMBER');
    const byLoc = groupings.includes('LOCATION');
    const groups = new Map<string, { key: { product_id: string; location_id?: string; batch_number?: string | null }; lots: LotRec[] }>();
    for (const lot of S().lots.values()) {
      const p = productOf(lot);
      if (!p || !p.is_active || lot.quantity <= 0 || f.none) continue;
      if (byBatch && p.tracking === 'PRODUCT') continue;
      if (f.product_ids && !f.product_ids.includes(p.id)) continue;
      if (f.location_ids && !f.location_ids.includes(lot.location_id)) continue;
      if (f.batch_ids && (!lot.batch_id || !f.batch_ids.includes(lot.batch_id))) continue;
      if (f.category && !f.category.includes(p.category_id)) continue;
      if (f.vendor && !f.vendor.includes(p.vendor_id)) continue;
      if (f.skus && !f.skus.includes(p.sku)) continue;
      if (f.strain && (!p.strain || !f.strain.includes(p.strain.id))) continue;
      const batchNumber = lot.batch_id ? (S().batches.get(lot.batch_id)?.batch_number ?? null) : null;
      const key: { product_id: string; location_id?: string; batch_number?: string | null } = { product_id: p.id };
      if (byLoc) key.location_id = lot.location_id;
      if (byBatch) key.batch_number = batchNumber;
      const k = JSON.stringify(groupings.map((g) => (g === 'PRODUCT' ? key.product_id : g === 'LOCATION' ? key.location_id : key.batch_number)));
      const g = groups.get(k) ?? { key, lots: [] };
      g.lots.push(lot);
      groups.set(k, g);
    }
    const sorted = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, g]) => g);
    return page(c, sorted, (g) => {
      const reserved = byBatch ? 0 : S().quantityReserved(g.key.product_id, byLoc ? [g.key.location_id!] : undefined);
      return ser.inventoryRow(g.key, g.lots, reserved);
    });
  });

  // ── products ────────────────────────────────────────────────────────────────────────────────
  app.get('/public/v1/products', (c) => {
    const q = new Query(c.req.url);
    const f = {
      ids: q.arr('ids'),
      name: q.str('name')?.toLowerCase(),
      sku: q.str('sku'),
      names: q.arr('names'),
      skus: q.arr('skus'),
      category_ids: q.arr('category_ids'),
      vendor_ids: q.arr('vendor_ids'),
      strain_ids: q.arr('strain_ids'),
      strain_types: q.arr('strain_types'),
      is_active: q.bool('is_active'),
      has_quantity_active: q.bool('has_quantity_active'),
      tracking: q.str('inventory_tracking_method'),
      updated: q.range('updated_datetime'),
      inserted: q.range('inserted_datetime'),
      deleted: q.bool('deleted'),
      includeBatches: q.bool('include_batches_with_active_quantity_by_location'),
      includePackages: q.bool('include_packages_with_active_quantity_by_location'),
      none: [q.arr('brand_ids'), q.arr('tag_ids'), q.arr('subcategory_ids'), q.arr('product_group_ids'), q.arr('menu_ids'), q.arr('upcs'), q.str('upc')].some(Boolean),
    };
    if (q.errors.length) return err(c, 400, q.errors);
    const list = [...S().products.values()]
      .filter((p) => {
        if (f.none || f.deleted) return false;
        if (f.ids && !f.ids.includes(p.id)) return false;
        if (f.name && !p.name.toLowerCase().includes(f.name)) return false;
        if (f.sku && p.sku !== f.sku) return false;
        if (f.names && !f.names.includes(p.name)) return false;
        if (f.skus && !f.skus.includes(p.sku)) return false;
        if (f.category_ids && !f.category_ids.includes(p.category_id)) return false;
        if (f.vendor_ids && !f.vendor_ids.includes(p.vendor_id)) return false;
        if (f.strain_ids && (!p.strain || !f.strain_ids.includes(p.strain.id))) return false;
        if (f.strain_types && (!p.strain || !f.strain_types.includes(p.strain.strain_type))) return false;
        if (f.is_active !== undefined && p.is_active !== f.is_active) return false;
        if (f.tracking && p.tracking !== f.tracking) return false;
        if (f.has_quantity_active !== undefined && S().quantityActive(p.id) > 0 !== f.has_quantity_active) return false;
        if (f.updated && !f.updated(p.updated_datetime)) return false;
        if (f.inserted && !f.inserted(p.inserted_datetime)) return false;
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return page(c, list, (p) => ser.product(p, { includeBatches: f.includeBatches, includePackages: f.includePackages }));
  });

  app.get('/public/v1/products/:id', (c) => {
    const p = S().products.get(c.req.param('id'));
    if (!p) return notFound(c, 'Product not found');
    const q = new Query(c.req.url);
    const includeBatches = q.bool('include_batches_with_active_quantity_by_location');
    const includePackages = q.bool('include_packages_with_active_quantity_by_location');
    if (q.errors.length) return err(c, 400, q.errors);
    return c.json({ data: ser.product(p, { includeBatches, includePackages }) });
  });

  // ── companies + locations ───────────────────────────────────────────────────────────────────
  app.get('/public/v1/companies', (c) => {
    const q = new Query(c.req.url);
    const f = {
      ids: q.arr('ids'),
      name: q.str('name')?.toLowerCase(),
      names: q.arr('names'),
      category: q.str('category'),
      rel: q.arr('relationship_type_ids'),
      states: q.arr('states'),
      city: q.str('city')?.toLowerCase(),
      license: q.str('license_number'),
      deleted: q.bool('deleted'),
      updated: q.range('updated_datetime'),
      inserted: q.range('inserted_datetime'),
    };
    if (q.errors.length) return err(c, 400, q.errors);
    const list = [...S().companies.values()]
      .filter((co) => {
        if (f.deleted) return false;
        if (f.ids && !f.ids.includes(co.id)) return false;
        if (f.name && !co.name.toLowerCase().includes(f.name)) return false;
        if (f.names && !f.names.includes(co.name)) return false;
        if (f.category && co.category !== f.category) return false;
        if (f.rel && !f.rel.includes(`rel-${co.relationship.toLowerCase()}`)) return false;
        const locs = co.location_ids.map((id) => S().locations.get(id)!);
        if (f.states && !locs.some((l) => f.states!.includes(l.state))) return false;
        if (f.city && !locs.some((l) => l.city.toLowerCase() === f.city)) return false;
        if (f.license && !co.license_ids.some((id) => S().licenses.get(id)?.license_number === f.license)) return false;
        if (f.updated && !f.updated(co.updated_datetime)) return false;
        if (f.inserted && !f.inserted(co.inserted_datetime)) return false;
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return page(c, list, (co) => ser.company(co));
  });

  app.get('/public/v1/companies/:id', (c) => {
    const co = S().companies.get(c.req.param('id'));
    return co ? c.json({ data: ser.company(co) }) : notFound(c, 'Company not found');
  });

  app.get('/public/v1/locations', (c) => {
    const q = new Query(c.req.url);
    const f = { ids: q.arr('ids'), name: q.str('name')?.toLowerCase(), license: q.str('license_number'), deleted: q.bool('deleted'), updated: q.range('updated_datetime') };
    if (q.errors.length) return err(c, 400, q.errors);
    // GET /locations lists your own locations (partner locations hang off companies)
    const list = S()
      .ownLocationIds.map((id) => S().locations.get(id)!)
      .filter((l) => {
        if (f.deleted) return false;
        if (f.ids && !f.ids.includes(l.id)) return false;
        if (f.name && !l.name.toLowerCase().includes(f.name)) return false;
        if (f.license && S().licenses.get(l.license_id)?.license_number !== f.license) return false;
        if (f.updated && !f.updated(l.updated_datetime)) return false;
        return true;
      });
    return page(c, list, (l) => ser.location(l));
  });

  // ── orders ──────────────────────────────────────────────────────────────────────────────────
  const ORDER_STATUSES = ['PENDING', 'PROCESSING', 'READY_TO_SHIP', 'DELIVERING', 'DELIVERED', 'COMPLETED', 'CANCELED'] as const;
  app.get('/public/v1/orders', (c) => {
    const q = new Query(c.req.url);
    const f = {
      ids: q.arr('ids'),
      statuses: q.enumArr('statuses', ORDER_STATUSES),
      company_ids: q.arr('company_ids'),
      location_ids: q.arr('location_ids'),
      product_ids: q.arr('product_ids'),
      product_skus: q.arr('product_skus'),
      vendor_ids: q.arr('product_vendor_ids'),
      batch_ids: q.arr('batch_ids'),
      order_number: q.str('order_number'),
      order_numbers: q.arr('order_numbers'),
      order_dt: q.range('order_datetime'),
      updated: q.range('updated_datetime'),
      inserted: q.range('inserted_datetime'),
      due: q.range('due_datetime'),
    };
    if (q.errors.length) return err(c, 400, q.errors);
    const prodMatch = (o: OrderRec) =>
      o.items.some((i) => {
        const p = productOf(i.product_id);
        if (f.product_ids && !f.product_ids.includes(i.product_id)) return false;
        if (f.product_skus && (!p || !f.product_skus.includes(p.sku))) return false;
        if (f.vendor_ids && (!p || !f.vendor_ids.includes(p.vendor_id))) return false;
        if (f.batch_ids && (!i.batch_id || !f.batch_ids.includes(i.batch_id))) return false;
        return true;
      });
    const needsItem = f.product_ids || f.product_skus || f.vendor_ids || f.batch_ids;
    const list = [...S().orders.values()]
      .filter((o) => {
        if (f.ids && !f.ids.includes(o.id)) return false;
        if (f.statuses && !f.statuses.includes(o.status)) return false;
        if (f.company_ids && !f.company_ids.includes(o.company_id)) return false;
        if (f.location_ids && !f.location_ids.includes(o.location_id)) return false;
        if (f.order_number && o.order_number !== f.order_number) return false;
        if (f.order_numbers && !f.order_numbers.includes(o.order_number)) return false;
        if (f.order_dt && !f.order_dt(o.order_datetime)) return false;
        if (f.updated && !f.updated(o.updated_datetime)) return false;
        if (f.inserted && !f.inserted(o.inserted_datetime)) return false;
        if (f.due && !f.due(o.due_datetime)) return false;
        if (needsItem && !prodMatch(o)) return false;
        return true;
      })
      .sort((a, b) => (a.order_datetime === b.order_datetime ? a.id.localeCompare(b.id) : a.order_datetime < b.order_datetime ? 1 : -1));
    return page(c, list, (o) => ser.order(o));
  });

  app.get('/public/v1/orders/:id', (c) => {
    const o = S().orders.get(c.req.param('id'));
    return o ? c.json({ data: ser.order(o) }) : notFound(c, 'Order not found');
  });

  const readJson = async (c: Context): Promise<{ ok: true; body: unknown } | { ok: false }> => {
    try {
      return { ok: true, body: await c.req.json() };
    } catch {
      return { ok: false };
    }
  };

  const createOrUpdateOrder = (body: unknown) => ops.upsertOrder(body, 'PUBLIC_API');

  app.post('/public/v1/orders', async (c) => {
    const parsed = await readJson(c);
    if (!parsed.ok) return err(c, 400, [{ message: 'Request body is not valid JSON', pointer: ['base'] }]);
    const res = createOrUpdateOrder(parsed.body);
    if (!res.ok) return err(c, res.status, res.errors);
    return c.json({ data: ser.order(res.record) }, 200);
  });

  // ── purchases ───────────────────────────────────────────────────────────────────────────────
  const PURCHASE_STATUSES = ['COMPLETED', 'DELIVERING', 'DRAFT', 'PENDING', 'PARTIALLY_RECEIVED', 'PROCESSING'] as const;
  app.get('/public/v1/purchases', (c) => {
    const q = new Query(c.req.url);
    const f = {
      ids: q.arr('ids'),
      statuses: q.enumArr('statuses', PURCHASE_STATUSES),
      payment_statuses: q.enumArr('payment_statuses', ['NOT_PAID', 'PARTIALLY_PAID', 'FULLY_PAID', 'OVER_PAID'] as const),
      company_ids: q.arr('company_ids'),
      location_ids: q.arr('location_ids'),
      product_ids: q.arr('product_ids'),
      product_skus: q.arr('product_skus'),
      vendor_ids: q.arr('product_vendor_ids'),
      batch_ids: q.arr('batch_ids'),
      purchase_number: q.str('purchase_number'),
      purchase_numbers: q.arr('purchase_numbers'),
      order_dt: q.range('order_datetime'),
      updated: q.range('updated_datetime'),
      inserted: q.range('inserted_datetime'),
      due: q.range('due_datetime'),
    };
    // custom_data[<field id>]=<option>: only filterable (dropdown / checkbox) fields
    const customFilters: [string, string][] = [];
    for (const [k, v] of q.sp) {
      const m = /^custom_data\[(\d+)\]$/.exec(k);
      if (!m) continue;
      const def = S().customFields.get(Number(m[1]));
      if (!def || def.parent_object !== 'purchase') q.errors.push({ message: 'is not a purchase custom field', pointer: ['custom_data', m[1]!] });
      else if (!def.filterable) q.errors.push({ message: 'is not filterable (only dropdown and checkbox fields can be)', pointer: ['custom_data', m[1]!] });
      else customFilters.push([m[1]!, v]);
    }
    if (q.errors.length) return err(c, 400, q.errors);
    const customMatch = (p: PurchaseRec) =>
      customFilters.every(([id, v]) => {
        const val = p.custom_data[id];
        return Array.isArray(val) ? val.includes(v) : val === v;
      });
    const itemMatch = (p: PurchaseRec) =>
      p.items.some((i) => {
        const pid = i.product_id ?? (i.batch_id ? S().batches.get(i.batch_id)?.product_id : undefined);
        const prod = pid ? productOf(pid) : undefined;
        if (f.product_ids && (!pid || !f.product_ids.includes(pid))) return false;
        if (f.product_skus && (!prod || !f.product_skus.includes(prod.sku))) return false;
        if (f.vendor_ids && (!prod || !f.vendor_ids.includes(prod.vendor_id))) return false;
        if (f.batch_ids && (!i.batch_id || !f.batch_ids.includes(i.batch_id))) return false;
        return true;
      });
    const needsItem = f.product_ids || f.product_skus || f.vendor_ids || f.batch_ids;
    const list = [...S().purchases.values()]
      .filter((p) => {
        if (f.statuses ? !f.statuses.includes(p.status) : p.status === 'DRAFT') return false;
        if (f.ids && !f.ids.includes(p.id)) return false;
        if (f.payment_statuses && !f.payment_statuses.includes(p.status === 'COMPLETED' ? 'FULLY_PAID' : 'NOT_PAID')) return false;
        if (f.company_ids && (!p.company_id || !f.company_ids.includes(p.company_id))) return false;
        if (f.location_ids && (!p.location_id || !f.location_ids.includes(p.location_id))) return false;
        if (f.purchase_number && p.purchase_number !== f.purchase_number) return false;
        if (f.purchase_numbers && !f.purchase_numbers.includes(p.purchase_number)) return false;
        if (f.order_dt && !f.order_dt(p.order_datetime)) return false;
        if (f.updated && !f.updated(p.updated_datetime)) return false;
        if (f.inserted && !f.inserted(p.inserted_datetime)) return false;
        if (f.due && !f.due(p.due_datetime)) return false;
        if (needsItem && !itemMatch(p)) return false;
        if (customFilters.length && !customMatch(p)) return false;
        return true;
      })
      .sort((a, b) => {
        const ad = a.order_datetime ?? a.inserted_datetime;
        const bd = b.order_datetime ?? b.inserted_datetime;
        return ad === bd ? a.id.localeCompare(b.id) : ad < bd ? 1 : -1;
      });
    return page(c, list, (p) => ser.purchase(p));
  });

  app.get('/public/v1/purchases/:id', (c) => {
    const p = S().purchases.get(c.req.param('id'));
    return p ? c.json({ data: ser.purchase(p) }) : notFound(c, 'Purchase not found');
  });

  app.post('/public/v1/purchases', async (c) => {
    const parsed = await readJson(c);
    if (!parsed.ok) return err(c, 400, [{ message: 'Request body is not valid JSON', pointer: ['base'] }]);
    const res = ops.upsertPurchase(parsed.body, 'PUBLIC_API');
    if (!res.ok) return err(c, res.status, res.errors);
    return c.json({ data: ser.purchase(res.record) }, 200);
  });

  // Hard delete (Distru has no cancelled status for purchases): lines, charges, payments and linked
  // tasks go with it; refused for Metrc-matched purchases or when received stock was already used.
  app.delete('/public/v1/purchases/:id', (c) => {
    const res = ops.deletePurchase(c.req.param('id'), 'PUBLIC_API');
    if (!res.ok) return err(c, res.status, res.errors);
    return c.body(null, 204);
  });

  // ── compliance: metrc packages, test results, batches ────────────────────────────────────────
  const METRC_STATUSES = ['ACTIVE', 'DISCONTINUED', 'FINISHED', 'ONHOLD', 'TRANSFERRED'] as const;
  app.get('/public/v1/metrc/packages', (c) => {
    const q = new Query(c.req.url);
    const f = {
      label: q.str('label'),
      search: q.str('search')?.toLowerCase(),
      statuses: q.enumArr('statuses', METRC_STATUSES),
      ids: q.arr('ids'),
      license_id: q.str('license_id'),
      license_number: q.str('license_number'),
      category_names: q.arr('category_names'),
      item_names: q.arr('item_names'),
      strain_names: q.arr('strain_names'),
      fetched: q.range('fetched_datetime'),
    };
    q.bool('is_importable');
    if (q.errors.length) return err(c, 400, q.errors);
    const list = [...S().lots.values()]
      .filter((l) => l.compliance_label && l.metrc_id)
      .map((l) => ser.metrcPackage(l))
      .filter((m) => {
        if (f.label && m.label !== f.label) return false;
        if (f.search && !(m.label ?? '').toLowerCase().includes(f.search) && !(m.item?.name ?? '').toLowerCase().includes(f.search)) return false;
        if (f.statuses && !f.statuses.includes(m.status)) return false;
        if (f.ids && !f.ids.includes(String(m.id))) return false;
        if (f.license_id && m.license?.id !== f.license_id) return false;
        if (f.license_number && m.license?.license_number !== f.license_number) return false;
        if (f.category_names && !f.category_names.includes(m.item?.category_name ?? '')) return false;
        if (f.item_names && !f.item_names.includes(m.item?.name ?? '')) return false;
        if (f.strain_names && !f.strain_names.includes(m.item?.strain?.name ?? '')) return false;
        if (f.fetched && !f.fetched(m.fetched_datetime)) return false;
        return true;
      })
      .sort((a, b) => a.id - b.id);
    return page(c, list, (m) => m);
  });

  app.get('/public/v1/test-results', (c) => {
    const q = new Query(c.req.url);
    const f = {
      ids: q.arr('ids'),
      batch_ids: q.arr('batch_ids'),
      product_ids: q.arr('product_ids'),
      package_ids: q.arr('package_ids'),
      metrc_ids: q.arr('metrc_ids'),
      updated: q.range('updated_datetime'),
      inserted: q.range('inserted_datetime'),
    };
    if (q.errors.length) return err(c, 400, q.errors);
    const list = [...S().testResults.values()]
      .filter((t) => {
        if (f.ids && !f.ids.includes(t.id)) return false;
        if (f.batch_ids && !f.batch_ids.includes(t.batch_id)) return false;
        if (f.product_ids && !f.product_ids.includes(S().batches.get(t.batch_id)?.product_id ?? '')) return false;
        if (f.package_ids && (!t.package_id || !f.package_ids.includes(t.package_id))) return false;
        if (f.metrc_ids && !f.metrc_ids.includes(String(t.metrc_id))) return false;
        if (f.updated && !f.updated(t.updated_datetime)) return false;
        if (f.inserted && !f.inserted(t.inserted_datetime)) return false;
        return true;
      })
      .sort((a, b) => (a.inserted_datetime < b.inserted_datetime ? 1 : -1));
    return page(c, list, (t) => ser.testResult(t));
  });

  app.get('/public/v1/test-results/:id', (c) => {
    const t = S().testResults.get(c.req.param('id'));
    return t ? c.json({ data: ser.testResult(t) }) : notFound(c, 'Test result not found');
  });

  app.get('/public/v1/batches', (c) => {
    const q = new Query(c.req.url);
    const f = {
      ids: q.arr('ids'),
      product_ids: q.arr('product_ids'),
      batch_number: q.str('batch_number'),
      batch_numbers: q.arr('batch_numbers'),
      category: q.arr('product_category_ids'),
      vendor: q.arr('product_vendor_ids'),
      skus: q.arr('product_skus'),
      strain: q.arr('product_strain_ids'),
      has_active: q.bool('has_quantity_active'),
      deleted: q.bool('deleted'),
      updated: q.range('updated_datetime'),
      inserted: q.range('inserted_datetime'),
      none: [q.arr('product_subcategory_ids'), q.arr('product_group_ids'), q.arr('product_brand_ids'), q.arr('product_tag_ids'), q.arr('owner_ids')].some(Boolean),
    };
    q.bool('include_costs');
    if (q.errors.length) return err(c, 400, q.errors);
    const list = [...S().batches.values()]
      .filter((b) => {
        const p = productOf(b.product_id);
        if (f.none || f.deleted || !p) return false;
        if (f.ids && !f.ids.includes(b.id)) return false;
        if (f.product_ids && !f.product_ids.includes(b.product_id)) return false;
        if (f.batch_number && b.batch_number !== f.batch_number) return false;
        if (f.batch_numbers && !f.batch_numbers.includes(b.batch_number)) return false;
        if (f.category && !f.category.includes(p.category_id)) return false;
        if (f.vendor && !f.vendor.includes(p.vendor_id)) return false;
        if (f.skus && !f.skus.includes(p.sku)) return false;
        if (f.strain && (!p.strain || !f.strain.includes(p.strain.id))) return false;
        if (f.has_active !== undefined) {
          const active = [...S().lots.values()].some((l) => l.batch_id === b.id && l.quantity > 0);
          if (active !== f.has_active) return false;
        }
        if (f.updated && !f.updated(b.updated_datetime)) return false;
        if (f.inserted && !f.inserted(b.inserted_datetime)) return false;
        return true;
      })
      .sort((a, b) => (a.inserted_datetime < b.inserted_datetime ? 1 : a.inserted_datetime > b.inserted_datetime ? -1 : a.id.localeCompare(b.id)));
    return page(c, list, (b) => ser.batch(b));
  });

  app.get('/public/v1/batches/:id', (c) => {
    const b = S().batches.get(c.req.param('id'));
    return b ? c.json({ data: ser.batch(b) }) : notFound(c, 'Batch not found');
  });

  // ── purchase PDF (shares the account PDF limit) ──────────────────────────────────────────────
  app.post('/public/v1/purchases/:id/pdf', async (c) => {
    const p = S().purchases.get(c.req.param('id'));
    if (!p || p.status === 'DRAFT') return notFound(c, 'Purchase not found');
    const parsed = await readJson(c);
    const body = parsed.ok && isObj(parsed.body) ? parsed.body : {};
    const format = body.format ?? 'binary';
    if (format !== 'binary' && format !== 'url' && format !== 'email') return err(c, 400, [{ message: 'must be one of binary, url, email', pointer: ['format'] }]);
    let emails: string[] = [];
    if (format === 'email') {
      const raw = Array.isArray(body.email_addresses) ? body.email_addresses : [];
      emails = [...new Set(raw.flatMap((e) => (typeof e === 'string' ? e.split(',') : [])).map((e) => e.trim()).filter(Boolean))];
      if (!emails.length) return err(c, 400, [{ message: 'at least one email address is required when format is email', pointer: ['email_addresses'] }]);
      const bad = emails.find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
      if (bad) return err(c, 400, [{ message: `is not a valid email address: ${bad}`, pointer: ['email_addresses'] }]);
      if (emails.length > 200) return err(c, 400, [{ message: 'at most 200 addresses', pointer: ['email_addresses'] }]);
    }
    const wait = restLimiter.pdfRetryAfter();
    if (wait !== null) {
      c.header('Retry-After', String(wait));
      return err(c, 429, [{ message: `PDF download rate limit exceeded (${restLimiter.pdf.per_minute}/minute, ${restLimiter.pdf.per_day}/day per account, aggregated across all PDF endpoints). Retry after the Retry-After period.`, pointer: ['base'] }]);
    }
    restLimiter.pdfSucceeded();
    if (format === 'binary') {
      const pdf = `%PDF-1.4\n% Distru mock purchase order ${p.purchase_number}\n%%EOF\n`;
      return new Response(pdf, { status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${p.purchase_number}.pdf"` } });
    }
    if (format === 'url') {
      const base = opts.publicUrl ?? new URL(c.req.url).origin;
      const expires = new Date(clock() + 15 * 60_000).toISOString();
      return c.json({ data: { url: `${base}/__mock/pdf/purchases/${p.id}.pdf?expires=${encodeURIComponent(expires)}&signature=mock`, expires_datetime: expires } });
    }
    ops.emailPdf({ document: 'PURCHASE_ORDER', recordId: p.id, recordName: p.purchase_number, to: emails }, 'PUBLIC_API');
    return c.json({ data: { emailed_to: emails } });
  });

  // ── tasks ───────────────────────────────────────────────────────────────────────────────────
  const TASK_RELATED = ['ASSEMBLY', 'BATCH', 'COMPANY', 'CONTACT', 'INVOICE', 'ORDER', 'PRODUCT', 'PURCHASE', 'RETURN'] as const;
  app.get('/public/v1/tasks', (c) => {
    const q = new Query(c.req.url);
    const f = {
      ids: q.arr('ids'),
      owner_ids: q.arr('owner_ids'),
      statuses: q.enumArr('statuses', ['ACTIVE', 'COMPLETED'] as const),
      related: q.enumArr('related_types', TASK_RELATED),
      due: q.range('due_datetime'),
      inserted: q.range('inserted_datetime'),
      updated: q.range('updated_datetime'),
    };
    if (q.errors.length) return err(c, 400, q.errors);
    const list = [...S().tasks.values()]
      .filter((t) => {
        if (f.ids && !f.ids.includes(t.id)) return false;
        if (f.owner_ids && (!t.owner_id || !f.owner_ids.includes(t.owner_id))) return false;
        if (f.statuses && !f.statuses.includes(t.status)) return false;
        if (f.related && (!t.link || !(f.related as readonly string[]).includes(t.link.kind.toUpperCase()))) return false;
        if (f.due && !f.due(t.due_datetime)) return false;
        if (f.inserted && !f.inserted(t.inserted_datetime)) return false;
        if (f.updated && !f.updated(t.updated_datetime)) return false;
        return true;
      })
      // oldest first, by creation time
      .sort((a, b) => (a.inserted_datetime === b.inserted_datetime ? a.id.localeCompare(b.id) : a.inserted_datetime < b.inserted_datetime ? -1 : 1));
    return page(c, list, (t) => ser.task(t));
  });

  app.get('/public/v1/tasks/:id', (c) => {
    const t = S().tasks.get(c.req.param('id'));
    return t ? c.json({ data: ser.task(t) }) : notFound(c, 'Task not found');
  });

  app.post('/public/v1/tasks', async (c) => {
    const parsed = await readJson(c);
    if (!parsed.ok) return err(c, 400, [{ message: 'Request body is not valid JSON', pointer: ['base'] }]);
    const res = ops.upsertTask(parsed.body, 'PUBLIC_API');
    if (!res.ok) return err(c, res.status, res.errors);
    return c.json({ data: ser.task(res.record) }, res.created ? 201 : 200);
  });

  app.delete('/public/v1/tasks/:id', (c) => {
    const res = ops.deleteTask(c.req.param('id'), 'PUBLIC_API');
    if (!res.ok) return err(c, res.status, res.errors);
    return c.body(null, 204);
  });

  // ── users ───────────────────────────────────────────────────────────────────────────────────
  app.get('/public/v1/users', (c) => {
    const q = new Query(c.req.url);
    const f = { ids: q.arr('ids'), updated: q.range('updated_datetime'), inserted: q.range('inserted_datetime'), deleted: q.str('deleted') };
    if (f.deleted && !['no', 'include', 'only'].includes(f.deleted)) q.errors.push({ message: 'must be one of no, include, only', pointer: ['deleted'] });
    if (q.errors.length) return err(c, 400, q.errors);
    const list = [...S().users.values()]
      .filter((u) => {
        if (f.deleted === 'only') return false;
        if (f.ids && !f.ids.includes(u.id)) return false;
        if (f.updated && !f.updated(u.updated_datetime)) return false;
        if (f.inserted && !f.inserted(u.inserted_datetime)) return false;
        return true;
      })
      .sort((a, b) => a.full_name.localeCompare(b.full_name));
    return page(c, list, (u) => ser.user(u));
  });

  app.get('/public/v1/users/:id', (c) => {
    const u = S().users.get(c.req.param('id'));
    return u ? c.json({ data: ser.user(u) }) : notFound(c, 'User not found');
  });

  // ── custom fields ───────────────────────────────────────────────────────────────────────────
  const customFieldJson = (d: import('./types').CustomFieldDefRec) => ({
    id: d.id,
    name: d.name,
    description: d.description,
    parent_object: d.parent_object,
    field_type: d.field_type,
    filterable: d.filterable,
    required: d.required,
    field_options: d.field_options,
    disabled_field_options: d.disabled_field_options,
  });
  app.get('/public/v1/custom-fields', (c) => {
    const parent = new URL(c.req.url).searchParams.get('parent_object');
    const list = [...S().customFields.values()].filter((d) => !parent || d.parent_object === parent).sort((a, b) => a.id - b.id);
    return page(c, list, customFieldJson);
  });
  app.get('/public/v1/custom-fields/:id', (c) => {
    const d = S().customFields.get(Number(c.req.param('id')));
    return d ? c.json({ data: customFieldJson(d) }) : notFound(c, 'Custom field not found');
  });
  app.post('/public/v1/custom-fields', async (c) => {
    const parsed = await readJson(c);
    if (!parsed.ok) return err(c, 400, [{ message: 'Request body is not valid JSON', pointer: ['base'] }]);
    const res = ops.createCustomField(parsed.body, 'PUBLIC_API');
    if (!res.ok) return err(c, res.status, res.errors);
    return c.json({ data: customFieldJson(res.record) }, 201);
  });

  // ── deleted records (90 days) ─────────────────────────────────────────────────────────────────
  const DELETED_TYPES = ['ADJUSTMENT', 'ASSEMBLY', 'BATCH', 'BIN', 'CHARGE_PRESET', 'COMPANY', 'COMPANY_GROUP', 'CONTACT', 'COST_TYPE', 'CREDIT', 'CUSTOM_FIELD', 'DRIVER', 'INVOICE', 'LICENSE', 'LOCATION', 'MENU', 'ORDER', 'PACKAGE', 'PAYMENT', 'PAYMENT_METHOD', 'PAYMENT_TERM', 'PRICE_TIER', 'PRODUCT', 'PRODUCT_CATEGORY', 'PRODUCT_GROUP', 'PRODUCT_POS_MAPPING', 'PRODUCT_SUBCATEGORY', 'PURCHASE', 'RETURN', 'STRAIN', 'TAG', 'TASK', 'TAX', 'TEST_RESULT', 'UNIT_TYPE', 'USER', 'VEHICLE'];
  app.get('/public/v1/deleted-records', (c) => {
    const q = new Query(c.req.url);
    const type = q.str('record_type');
    if (!type) q.errors.push({ message: "can't be blank", pointer: ['record_type'] });
    else if (!DELETED_TYPES.includes(type)) q.errors.push({ message: `is invalid; allowed: ${DELETED_TYPES.join(', ')}`, pointer: ['record_type'] });
    const when = q.range('deleted_datetime');
    if (q.errors.length) return err(c, 400, q.errors);
    const keepFrom = clock() - 90 * 86_400_000;
    const list = S()
      .deletedRecords.filter((d) => d.record_type === type && Date.parse(d.deleted_datetime) >= keepFrom && (!when || when(d.deleted_datetime)))
      .sort((a, b) => (a.deleted_datetime < b.deleted_datetime ? -1 : 1));
    return page(c, list, (d) => ({ record_type: d.record_type, record_id: d.record_id, deleted_datetime: d.deleted_datetime }));
  });

  // ── activity + record history (fed by REST and MCP writes) ─────────────────────────────────────
  const SOURCES = ['AI_AGENT', 'AUTOMATION', 'BIOTRACK', 'IMPORT', 'JOB', 'LEGACY', 'MCP', 'METRC', 'MIGRATION', 'MOBILE', 'PARTNER_API', 'PUBLIC_API', 'QUICKBOOKS', 'STAFF_SQL', 'UNKNOWN', 'WEB'] as const;
  app.get('/public/v1/activity', (c) => {
    const q = new Query(c.req.url);
    const ids = q.arr('ids');
    const f = {
      changed: q.range('changed_datetime'),
      user_ids: q.arr('user_ids'),
      sources: q.enumArr('sources', SOURCES),
      ops: q.enumArr('ops', ['DELETE', 'INSERT', 'UPDATE'] as const),
      record_types: q.arr('record_types'),
    };
    if (q.errors.length) return err(c, 400, q.errors);
    // default window: the last 7 days (ids[] reads whenever they ran)
    const defaultFrom = clock() - 7 * 86_400_000;
    const list = [...S().activity]
      .reverse()
      .filter((a) => {
        if (ids) return ids.includes(a.id);
        if (f.changed ? !f.changed(a.changed_datetime) : Date.parse(a.changed_datetime) < defaultFrom) return false;
        if (f.user_ids && (!a.actor_id || !f.user_ids.includes(a.actor_id))) return false;
        if (f.sources && !(f.sources as readonly string[]).includes(a.source)) return false;
        if (f.ops && !a.records.some((r) => (f.ops as readonly string[]).includes(r.op))) return false;
        if (f.record_types && !a.records.some((r) => r.type && f.record_types!.includes(r.type))) return false;
        return true;
      });
    return page(c, list, (a) => serializeActivity(S(), a, f.record_types), 100);
  });

  const RECORD_LOOKUP: Record<string, (s: Store, id: string) => boolean> = {
    PURCHASE: (s, id) => s.purchases.has(id),
    SALES_ORDER: (s, id) => s.orders.has(id),
    PRODUCT: (s, id) => s.products.has(id),
    BATCH: (s, id) => s.batches.has(id),
    PACKAGE: (s, id) => s.lots.has(id),
    COMPANY: (s, id) => s.companies.has(id),
    USER: (s, id) => s.users.has(id),
    TEST_RESULT: (s, id) => s.testResults.has(id),
  };
  app.get('/public/v1/record-history', (c) => {
    const q = new Query(c.req.url);
    const type = q.str('record_type');
    const id = q.str('record_id');
    if (!type) q.errors.push({ message: "can't be blank", pointer: ['record_type'] });
    if (!id) q.errors.push({ message: "can't be blank", pointer: ['record_id'] });
    if (q.errors.length) return err(c, 400, q.errors);
    const entries = recordHistory(S(), type!, id!);
    if (!entries.length && !RECORD_LOOKUP[type!]?.(S(), id!)) return notFound(c, 'Record not found');
    return page(c, entries, (e) => e, 100);
  });

  app.all('/public/v1/*', (c) => notFound(c));

  // ── mock control plane ──────────────────────────────────────────────────────────────────────
  app.get('/__mock/scenarios', (c) => c.json({ current: state.scenario, scenarios: Object.fromEntries(Object.entries(SCENARIOS).map(([k, v]) => [k, v.description])) }));

  app.post('/__mock/reset', async (c) => {
    const text = await c.req.text();
    let body: { scenario?: unknown; now?: unknown } = {};
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        return err(c, 400, [{ message: 'Request body is not valid JSON', pointer: ['base'] }]);
      }
    }
    const scenario = body.scenario ?? state.scenario;
    if (typeof scenario !== 'string' || !isScenario(scenario)) {
      return err(c, 400, [{ message: `unknown scenario; one of ${Object.keys(SCENARIOS).join(', ')}`, pointer: ['scenario'] }]);
    }
    const now = typeof body.now === 'string' && !Number.isNaN(Date.parse(body.now)) ? new Date(body.now) : undefined;
    reset(scenario, now);
    state.rateLimit.fail_next = 0;
    return c.json({ ok: true, seed: S().summary });
  });

  const stateView = () => {
    const s = S();
    return {
      scenario: state.scenario,
      seed: s.summary,
      config: configView(),
      requests: state.requests,
      rate_limit_budget: { list: restLimiter.headers(), pdf: { minute_remaining: restLimiter.pdfMinute.remaining(), day_remaining: restLimiter.pdfDay.remaining() } },
      counts: {
        locations: s.ownLocationIds.length,
        companies: s.companies.size,
        products: s.products.size,
        batches: s.batches.size,
        packages: s.lots.size,
        test_results: s.testResults.size,
        orders: s.orders.size,
        open_orders: [...s.orders.values()].filter((o) => ['PENDING', 'PROCESSING', 'READY_TO_SHIP', 'DELIVERING'].includes(o.status)).length,
        purchases: s.purchases.size,
        users: s.users.size,
        tasks: s.tasks.size,
        custom_fields: s.customFields.size,
        activity: s.activity.length,
        deleted_records: s.deletedRecords.length,
        outbox: s.outbox.length,
        menus: s.menus.size,
      },
      users: [...s.users.values()].map((u) => ({ id: u.id, name: u.full_name, email: u.email, role: u.role.name })),
      menus: [...s.menus.values()].map((m) => ({
        id: m.id,
        name: m.name,
        active: m.active,
        visibility: m.visibility,
        location_ids: m.location_ids,
        products: [...s.products.values()].filter((p) => isOnMenu(p, m.id)).length,
        updated_datetime: m.updated_datetime,
      })),
      buyer_caps: [...s.products.values()].filter((p) => p.max_menu_buyer_order_quantity != null).map((p) => ({ product_id: p.id, sku: p.sku, max_menu_buyer_order_quantity: p.max_menu_buyer_order_quantity })),
      custom_fields: [...s.customFields.values()].map((d) => ({ id: d.id, name: d.name, parent_object: d.parent_object, field_type: d.field_type, filterable: d.filterable })),
      locations: s.ownLocationIds.map((id) => ({ id, name: s.locations.get(id)!.name })),
      vendors: [...s.companies.values()]
        .filter((c) => c.relationship === 'Vendor')
        .map((v) => ({ id: v.id, name: v.name, typical_lead_time_days: v.lead_time_days })),
      recent_purchases: [...s.purchases.values()]
        .sort((a, b) => (a.updated_datetime < b.updated_datetime ? 1 : -1))
        .slice(0, 10)
        .map((p) => ({ id: p.id, purchase_number: p.purchase_number, status: p.status, total: ser.purchaseTotal(p).toFixed(2), updated_datetime: p.updated_datetime })),
      webhooks: s.webhookLog.slice(-50),
      activity: s.activity.slice(-20).reverse().map((a) => ({ id: a.id, at: a.changed_datetime, source: a.source, records: a.records.map((r) => ({ type: r.type, id: r.id, name: r.name, op: r.op, rows: r.rows.length })) })),
      outbox: s.outbox.slice(-50),
      mcp: {
        url: '/mcp',
        telemetry: s.mcpTelemetry.slice(-100),
        adjustments: [...s.adjustments.values()].slice(-20),
      },
    };
  };
  app.get('/__mock/state', (c) => c.json(stateView()));

  function configView() {
    return {
      rate_limit: state.rateLimit,
      mcp_rate_limit: mcpLimiter.config,
      webhook_url: webhooks.config.url ?? null,
      webhook_retry_delays_ms: webhooks.config.retryDelaysMs ?? null,
      metrc_fail_next: state.metrc.fail_next,
      page_size: pageSize,
    };
  }
  app.get('/__mock/config', (c) => c.json(configView()));
  /**
   * Body (all optional):
   * - rate_limit: { fail_next, every, retry_after, list: { enabled, capacity, refill_per_minute, free_window_days, tokens }, pdf: { per_minute, per_day } }
   * - mcp_rate_limit: { burst, per_minute, per_hour, writes_per_minute, pdf_per_minute, pdf_per_day, max_in_flight, max_batch, fail_next, retry_after, latency_ms }
   * - webhook_url, webhook_retry_delays_ms, metrc_fail_next
   */
  app.post('/__mock/config', async (c) => {
    const parsed = await readJson(c);
    if (!parsed.ok || !isObj(parsed.body)) return err(c, 400, [{ message: 'Request body must be a JSON object', pointer: ['base'] }]);
    const body = parsed.body;
    const errors: ApiErrorItem[] = [];
    const nonNeg = (v: unknown, ptr: (string | number)[], int = true): v is number => {
      const ok = typeof v === 'number' && Number.isFinite(v) && v >= 0 && (!int || Number.isInteger(v));
      if (!ok) errors.push({ message: `must be a non-negative ${int ? 'integer' : 'number'}`, pointer: ptr });
      return ok;
    };
    const rl = body.rate_limit;
    if (rl !== undefined) {
      if (!isObj(rl)) errors.push({ message: 'must be an object', pointer: ['rate_limit'] });
      else {
        for (const k of ['fail_next', 'every', 'retry_after'] as const) if (rl[k] !== undefined && nonNeg(rl[k], ['rate_limit', k])) state.rateLimit[k] = rl[k];
        const list: Partial<RestListLimitConfig> = {};
        const pdf: Partial<PdfLimitConfig> = {};
        if (isObj(rl.list)) {
          if (rl.list.enabled !== undefined) {
            if (typeof rl.list.enabled === 'boolean') list.enabled = rl.list.enabled;
            else errors.push({ message: 'must be a boolean', pointer: ['rate_limit', 'list', 'enabled'] });
          }
          for (const k of ['capacity', 'refill_per_minute', 'free_window_days'] as const) if (rl.list[k] !== undefined && nonNeg(rl.list[k], ['rate_limit', 'list', k], false)) list[k] = rl.list[k];
        }
        if (isObj(rl.pdf)) for (const k of ['per_minute', 'per_day'] as const) if (rl.pdf[k] !== undefined && nonNeg(rl.pdf[k], ['rate_limit', 'pdf', k])) pdf[k] = rl.pdf[k];
        if (!errors.length) {
          restLimiter.reconfigure(list, pdf);
          if (isObj(rl.list) && rl.list.tokens !== undefined && nonNeg(rl.list.tokens, ['rate_limit', 'list', 'tokens'], false)) restLimiter.bucket.set(rl.list.tokens);
        }
      }
    }
    const mrl = body.mcp_rate_limit;
    if (mrl !== undefined) {
      if (!isObj(mrl)) errors.push({ message: 'must be an object', pointer: ['mcp_rate_limit'] });
      else {
        const patch: Partial<McpRateLimitConfig> = {};
        for (const k of Object.keys(DEFAULT_MCP_LIMIT) as (keyof McpRateLimitConfig)[]) if (mrl[k] !== undefined && nonNeg(mrl[k], ['mcp_rate_limit', k])) patch[k] = mrl[k];
        if (!errors.length) {
          const onlyToggles = Object.keys(patch).every((k) => k === 'fail_next' || k === 'retry_after' || k === 'latency_ms');
          if (onlyToggles) Object.assign(mcpLimiter.config, patch);
          else mcpLimiter.reconfigure(patch);
        }
      }
    }
    if (body.webhook_url !== undefined) webhooks.config.url = typeof body.webhook_url === 'string' && body.webhook_url ? body.webhook_url : undefined;
    if (body.webhook_retry_delays_ms !== undefined) {
      const d = body.webhook_retry_delays_ms;
      if (d === null) webhooks.config.retryDelaysMs = undefined;
      else if (Array.isArray(d) && d.every((x) => typeof x === 'number' && x >= 0)) webhooks.config.retryDelaysMs = d;
      else errors.push({ message: 'must be a list of non-negative numbers (ms) or null', pointer: ['webhook_retry_delays_ms'] });
    }
    if (body.metrc_fail_next !== undefined && nonNeg(body.metrc_fail_next, ['metrc_fail_next'])) state.metrc.fail_next = body.metrc_fail_next;
    if (errors.length) return err(c, 400, errors);
    return c.json(configView());
  });

  /** Creates a sales order (emits an ORDER CREATE webhook) to drive demo flows. */
  app.post('/__mock/simulate/order', async (c) => {
    const text = await c.req.text();
    type SimItem = { product_id?: string; sku?: string; quantity?: number; price?: number };
    let body: { company_id?: string; location_id?: string; status?: string; items?: SimItem[]; menu_id?: string; placed_by?: 'buyer' | 'sales_rep' } = {};
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        return err(c, 400, [{ message: 'Request body is not valid JSON', pointer: ['base'] }]);
      }
    }
    const s = S();
    const customers = [...s.companies.values()].filter((co) => co.relationship === 'Customer');
    const n = s.orders.size;
    const lowSkus = s.summary?.below_reorder_skus ?? [];
    const defaultItems: SimItem[] = [
      { sku: lowSkus[n % Math.max(1, lowSkus.length)] ?? 'FLW-BD-35', quantity: 24 },
      { sku: 'PRE-OGK-1G', quantity: 50 },
    ];
    const items: Record<string, unknown>[] = [];
    const errors: ApiErrorItem[] = [];
    (body.items?.length ? body.items : defaultItems).forEach((it, i) => {
      const p = it.product_id ? s.products.get(it.product_id) : [...s.products.values()].find((x) => x.sku === it.sku);
      if (!p) return errors.push({ message: 'unknown product (pass product_id or sku)', pointer: ['items', i] });
      items.push({ product_id: p.id, quantity: it.quantity ?? 10, price_base: it.price ?? p.unit_price });
    });
    if (errors.length) return err(c, 400, errors);
    // a DistruCommerce menu order: the menu's rules apply (per-buyer cap, whole cases, availability)
    const menu = body.menu_id ? s.menus.get(body.menu_id) : undefined;
    if (body.menu_id && !menu) return err(c, 400, [{ message: 'does not exist', pointer: ['menu_id'] }]);
    if (menu) {
      const placedBy = body.placed_by ?? 'buyer';
      if (placedBy !== 'buyer' && placedBy !== 'sales_rep') return err(c, 400, [{ message: 'must be buyer or sales_rep', pointer: ['placed_by'] }]);
      const menuErrors = menuOrderErrors(s, menu, items.map((i) => ({ product_id: String(i.product_id), quantity: Number(i.quantity) })), placedBy);
      if (menuErrors.length) return err(c, 400, menuErrors);
    }
    const res = createOrUpdateOrder({
      company_id: body.company_id ?? customers[n % customers.length]!.id,
      location_id: body.location_id ?? menu?.location_ids[0] ?? s.ownLocationIds[0],
      status: body.status ?? (menu?.default_order_status === 'Processing' ? 'PROCESSING' : 'PENDING'),
      items,
    });
    if (!res.ok) return err(c, res.status, res.errors);
    if (menu) res.record.menu_id = menu.id;
    return c.json({ data: ser.order(res.record) }, 201);
  });

  // ── Distru MCP mock (Streamable HTTP), same store as the REST API ────────────────────────────────
  const mcp = createMcpRoute({
    store: () => state.store,
    ser: () => ser,
    ops,
    limiter: mcpLimiter,
    key: opts.mcpKey,
  } satisfies McpMockOptions);
  app.all('/mcp', (c) => mcp(c.req.raw));

  app.notFound((c) => notFound(c));
  app.onError((e, c) => {
    console.error('[distru-mock]', e);
    return c.json({ errors: [{ message: 'Internal server error', pointer: ['base'] }] }, 500);
  });

  return {
    app,
    reset,
    webhooks,
    get store() {
      return state.store;
    },
    get scenario() {
      return state.scenario;
    },
    get rateLimit() {
      return state.rateLimit;
    },
    restLimiter,
    mcpLimiter,
    ops,
    metrc: state.metrc,
  };
}

export type MockServer = ReturnType<typeof createMockServer>;
export { SCENARIOS, LOW_STOCK_SKUS, FAILED_TEST_SKU, INJECTION_SKU, INJECTION_TEXT } from './seed';
