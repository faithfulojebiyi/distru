/**
 * Mock of Distru's public REST API (`/public/v1/...`), schema-faithful to docs.distru.com/openapi.json
 * for the endpoints the Ops Agent uses, plus `/__mock/*` control endpoints.
 */
import { Hono, type Context } from 'hono';
import { isScenario, SCENARIOS, seedStore, type ScenarioName } from './seed';
import { Serializer } from './serialize';
import type { Store } from './store';
import type { LotRec, OrderRec, ProductRec, PurchaseRec } from './types';
import { upsertOrder, upsertPurchase, type ApiErrorItem } from './upsert';
import { inventoryVelocityReport } from './velocity';
import { computeChanges, WebhookDispatcher } from './webhooks';

export interface RateLimitConfig {
  /** the next N /public/v1 requests get a 429 */
  fail_next: number;
  /** every Nth /public/v1 request gets a 429 (0 = off) */
  every: number;
  /** Retry-After seconds on simulated 429s */
  retry_after: number;
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
  rateLimit?: Partial<RateLimitConfig>;
  /** base used in next_page URLs; defaults to the request origin */
  publicUrl?: string;
}

const err = (c: Context, status: 400 | 401 | 403 | 404 | 429, errors: ApiErrorItem[]) => c.json({ errors }, status);
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
  const state = {
    scenario: (opts.scenario ?? 'default') as ScenarioName,
    store: seedStore(opts.scenario ?? 'default', anchor()),
    rateLimit: { fail_next: 0, every: 0, retry_after: 2, ...opts.rateLimit } as RateLimitConfig,
    requests: 0,
  };
  let ser = new Serializer(state.store);
  const webhooks = new WebhookDispatcher(() => state.store, {
    url: opts.webhookUrl,
    secret: opts.webhookSecret ?? 'mock-webhook-secret',
    fetch: opts.webhookFetch,
    retryDelaysMs: opts.webhookRetryDelaysMs,
  });
  const reset = (scenario: ScenarioName = state.scenario, now?: Date) => {
    state.scenario = scenario;
    state.store = seedStore(scenario, now ?? anchor());
    ser = new Serializer(state.store);
  };
  const S = () => state.store;

  /** Paginate an already-filtered list; next_page carries the original filters + page[after]. */
  function page<T, U>(c: Context, items: T[], map: (t: T) => U) {
    const url = new URL(c.req.url);
    const cursor = url.searchParams.get('page[after]');
    let offset = 0;
    if (cursor !== null) {
      const o = decodeCursor(cursor);
      if (o === null) return err(c, 400, [{ message: 'is not a valid page cursor', pointer: ['page'] }]);
      offset = o;
    }
    const slice = items.slice(offset, offset + pageSize);
    let next_page: string | null = null;
    if (offset + pageSize < items.length) {
      const kept = url.search
        .replace(/^\?/, '')
        .split('&')
        .filter((kv) => kv && !/^page(\[|%5B)after(\]|%5D)=/i.test(kv));
      kept.push(`page[after]=${encodeCursor(offset + pageSize)}`);
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

  const createOrUpdateOrder = (body: unknown) => {
    const res = upsertOrder(S(), body);
    if (res.ok) {
      const after = ser.order(res.record);
      const before = res.before ? ser.order(res.before) : null;
      webhooks.emit('ORDER', res.created ? 'CREATE' : 'UPDATE', res.record.id, after, computeChanges(before, after));
    }
    return res;
  };

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
    if (q.errors.length) return err(c, 400, q.errors);
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
    const res = upsertPurchase(S(), parsed.body);
    if (!res.ok) return err(c, res.status, res.errors);
    const after = ser.purchase(res.record);
    const before = res.before ? ser.purchase(res.before) : null;
    webhooks.emit('PURCHASE', res.created ? 'CREATE' : 'UPDATE', res.record.id, after, computeChanges(before, after));
    return c.json({ data: after }, 200);
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
      config: { rate_limit: state.rateLimit, webhook_url: webhooks.config.url ?? null, page_size: pageSize },
      requests: state.requests,
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
      },
      locations: s.ownLocationIds.map((id) => ({ id, name: s.locations.get(id)!.name })),
      vendors: [...s.companies.values()]
        .filter((c) => c.relationship === 'Vendor')
        .map((v) => ({ id: v.id, name: v.name, typical_lead_time_days: v.lead_time_days })),
      recent_purchases: [...s.purchases.values()]
        .sort((a, b) => (a.updated_datetime < b.updated_datetime ? 1 : -1))
        .slice(0, 10)
        .map((p) => ({ id: p.id, purchase_number: p.purchase_number, status: p.status, total: ser.purchaseTotal(p).toFixed(2), updated_datetime: p.updated_datetime })),
      webhooks: s.webhookLog.slice(-50),
    };
  };
  app.get('/__mock/state', (c) => c.json(stateView()));

  app.get('/__mock/config', (c) => c.json({ rate_limit: state.rateLimit, webhook_url: webhooks.config.url ?? null }));
  app.post('/__mock/config', async (c) => {
    const parsed = await readJson(c);
    if (!parsed.ok || typeof parsed.body !== 'object' || parsed.body === null) return err(c, 400, [{ message: 'Request body must be a JSON object', pointer: ['base'] }]);
    const body = parsed.body as { rate_limit?: Partial<RateLimitConfig>; webhook_url?: string | null };
    const errors: ApiErrorItem[] = [];
    if (body.rate_limit) {
      for (const k of ['fail_next', 'every', 'retry_after'] as const) {
        const v = body.rate_limit[k];
        if (v === undefined) continue;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) errors.push({ message: 'must be a non-negative integer', pointer: ['rate_limit', k] });
        else state.rateLimit[k] = v;
      }
    }
    if (body.webhook_url !== undefined) webhooks.config.url = body.webhook_url ?? undefined;
    if (errors.length) return err(c, 400, errors);
    return c.json({ rate_limit: state.rateLimit, webhook_url: webhooks.config.url ?? null });
  });

  /** Creates a sales order (emits an ORDER CREATE webhook) to drive demo flows. */
  app.post('/__mock/simulate/order', async (c) => {
    const text = await c.req.text();
    type SimItem = { product_id?: string; sku?: string; quantity?: number; price?: number };
    let body: { company_id?: string; location_id?: string; status?: string; items?: SimItem[] } = {};
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
    const res = createOrUpdateOrder({
      company_id: body.company_id ?? customers[n % customers.length]!.id,
      location_id: body.location_id ?? s.ownLocationIds[0],
      status: body.status ?? 'PENDING',
      items,
    });
    if (!res.ok) return err(c, res.status, res.errors);
    return c.json({ data: ser.order(res.record) }, 201);
  });

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
  };
}

export type MockServer = ReturnType<typeof createMockServer>;
export { SCENARIOS, LOW_STOCK_SKUS, FAILED_TEST_SKU, INJECTION_SKU, INJECTION_TEXT } from './seed';
