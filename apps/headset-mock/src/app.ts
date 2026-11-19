/**
 * Headset-style retail analytics mock (Hono). Headset's real API is partner-only; this contract is
 * OUR OWN, inspired by what Headset exposes (retail sell-through per product per store), not theirs.
 */
import { Hono, type Context } from 'hono';
import { CATALOG, STORES, bySku, byStoreId } from './catalog';
import { aggregate, buildDataset, isScenario, pct, SCENARIO_SKUS, SCENARIOS, trendMetrics, WEEKS, type Dataset, type ScenarioName } from './data';

export { CATALOG, STORES } from './catalog';
export { SCENARIOS, SCENARIO_SKUS, WEEKS, buildDataset, weekStartsFor, type ScenarioName } from './data';

export interface HeadsetMockOptions {
  token?: string;
  scenario?: ScenarioName;
  /** anchor date (defaults to now); weeks are the 16 complete Mon–Sun weeks before it */
  now?: Date | string;
  /** default page size (max 200) */
  pageSize?: number;
}

type Status = 400 | 401 | 404;
const fail = (c: Context, status: Status, code: string, message: string) => c.json({ error: { code, message } }, status);

const MAX_LIMIT = 200;
const encodeCursor = (offset: number) => Buffer.from(`o:${offset}`).toString('base64url');
function decodeCursor(cursor: string | undefined): number | null {
  if (!cursor) return 0;
  const m = /^o:(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString());
  return m ? Number(m[1]) : null;
}

/** `skus[]=a&skus[]=b` or `skus=a,b`. */
function list(c: Context, name: string): string[] {
  const values = [...(c.req.queries(`${name}[]`) ?? []), ...(c.req.queries(name) ?? []).flatMap((v) => v.split(','))];
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

export function createHeadsetMock(opts: HeadsetMockOptions = {}) {
  const token = opts.token ?? 'headset-mock-token';
  const pageSize = Math.min(opts.pageSize ?? 50, MAX_LIMIT);
  const anchor = () => (opts.now ? new Date(opts.now) : new Date());
  const state: { ds: Dataset } = { ds: buildDataset(opts.scenario ?? 'default', anchor()) };

  const app = new Hono();

  /** Paging helper: returns `null` (and the response) on a bad cursor/limit. */
  function page<T>(c: Context, items: readonly T[]) {
    const offset = decodeCursor(c.req.query('cursor'));
    const rawLimit = c.req.query('limit');
    const limit = rawLimit === undefined ? pageSize : Number(rawLimit);
    if (offset === null) return { error: fail(c, 400, 'invalid_cursor', 'cursor is not valid') };
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return { error: fail(c, 400, 'invalid_limit', `limit must be 1..${MAX_LIMIT}`) };
    const data = items.slice(offset, offset + limit);
    const next = offset + limit < items.length ? encodeCursor(offset + limit) : null;
    return { body: { data, next_cursor: next, total: items.length } };
  }

  function weeksParam(c: Context, def: number, min: number): number | { error: Response } {
    const raw = c.req.query('weeks');
    if (raw === undefined || raw === '') return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > WEEKS) return { error: fail(c, 400, 'invalid_weeks', `weeks must be ${min}..${WEEKS}`) };
    return n;
  }

  function skuParam(c: Context): string[] | { error: Response } {
    const skus = list(c, 'skus');
    if (skus.length > 100) return { error: fail(c, 400, 'too_many_skus', 'at most 100 skus') };
    const unknown = skus.filter((s) => !bySku.has(s));
    if (unknown.length) return { error: fail(c, 400, 'unknown_sku', `unknown sku(s): ${unknown.join(', ')}`) };
    return skus;
  }

  app.get('/health', (c) => c.json({ ok: true, scenario: state.ds.scenario, latest_week: state.ds.weekStarts.at(-1) }));

  app.use('/v1/*', async (c, next) => {
    if (c.req.header('Authorization') !== `Bearer ${token}`) return fail(c, 401, 'unauthorized', 'missing or invalid bearer token');
    await next();
  });

  app.get('/v1/stores', (c) => {
    const p = page(c, STORES.map(({ id, name, city, state: st }) => ({ id, name, city, state: st })));
    return p.error ?? c.json(p.body);
  });

  app.get('/v1/products', (c) => {
    const q = (c.req.query('q') ?? '').trim().toLowerCase();
    const skus = list(c, 'skus');
    const items = CATALOG.filter((p) => (!skus.length || skus.includes(p.sku)) && (!q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase() === q)).map(
      ({ sku, name, brand, category }) => ({ sku, name, brand, category }),
    );
    const p = page(c, items);
    return p.error ?? c.json(p.body);
  });

  app.get('/v1/sell-through', (c) => {
    const skus = skuParam(c);
    if (!Array.isArray(skus)) return skus.error;
    const storeIds = list(c, 'store_ids');
    const unknownStores = storeIds.filter((s) => !byStoreId.has(s));
    if (unknownStores.length) return fail(c, 400, 'unknown_store', `unknown store id(s): ${unknownStores.join(', ')}`);
    const weeks = weeksParam(c, 8, 1);
    if (typeof weeks !== 'number') return weeks.error;
    const ds = state.ds;
    const rows = (skus.length ? skus : CATALOG.map((p) => p.sku)).flatMap((sku) =>
      (ds.bySku.get(sku) ?? [])
        .filter((s) => !storeIds.length || storeIds.includes(s.store_id))
        .map((s) => ({ sku, product_name: bySku.get(sku)!.name, store_id: s.store_id, store_name: byStoreId.get(s.store_id)!.name, weeks: s.weeks.slice(-weeks) })),
    );
    const p = page(c, rows);
    return p.error ?? c.json({ ...p.body, week_starts: ds.weekStarts.slice(-weeks) });
  });

  app.get('/v1/trends', (c) => {
    const skus = skuParam(c);
    if (!Array.isArray(skus)) return skus.error;
    const weeks = weeksParam(c, 8, 1);
    if (typeof weeks !== 'number') return weeks.error;
    const ds = state.ds;
    const rows = (skus.length ? skus : CATALOG.map((p) => p.sku)).map((sku) => {
      const p = bySku.get(sku)!;
      const agg = aggregate(ds, sku);
      const has_data = agg.some((w) => w.units > 0);
      return {
        sku,
        product_name: p.name,
        brand: p.brand,
        category: p.category,
        has_data,
        ...trendMetrics(agg),
        weekly: agg.slice(-weeks).map(({ week_start, units, revenue, stores_carrying, oos_days }) => ({ week_start, units, revenue, stores_carrying, oos_days })),
      };
    });
    const p = page(c, rows);
    return p.error ?? c.json({ ...p.body, latest_week: ds.weekStarts.at(-1), weeks_available: [...ds.bySku.values()].some((series) => series.length > 0) ? WEEKS : 0 });
  });

  app.get('/v1/top-movers', (c) => {
    const window = c.req.query('window') ?? '28d';
    if (window !== '7d' && window !== '28d') return fail(c, 400, 'invalid_window', "window must be '7d' or '28d'");
    const direction = c.req.query('direction') ?? 'both';
    if (direction !== 'up' && direction !== 'down' && direction !== 'both') return fail(c, 400, 'invalid_direction', "direction must be 'up', 'down' or 'both'");
    const rawLimit = c.req.query('limit');
    const limit = rawLimit === undefined ? 10 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) return fail(c, 400, 'invalid_limit', 'limit must be 1..50');
    const span = window === '7d' ? 1 : 4;
    const ds = state.ds;
    const rows = CATALOG.flatMap((p) => {
      const agg = aggregate(ds, p.sku);
      const units = agg.slice(-span).reduce((a, w) => a + w.units, 0);
      const prior = agg.slice(-2 * span, -span).reduce((a, w) => a + w.units, 0);
      const change = pct(units, prior);
      // ignore tiny volumes (noise) and products with no prior sales
      if (change === null || prior < 10 * span) return [];
      const oos = agg.slice(-span).reduce((a, w) => a + w.oos_days, 0);
      return [{ sku: p.sku, product_name: p.name, category: p.category, units, prior_units: prior, change_pct: change, direction: change >= 0 ? 'up' : 'down', stores_carrying: agg.at(-1)!.stores_carrying, oos_days: oos }];
    })
      .filter((r) => direction === 'both' || r.direction === direction)
      .sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct) || a.sku.localeCompare(b.sku))
      .slice(0, limit);
    return c.json({ data: rows, window, latest_week: ds.weekStarts.at(-1) });
  });

  // ── mock controls ──────────────────────────────────────────────────────────────────────────
  app.get('/__mock/scenarios', (c) =>
    c.json({ current: state.ds.scenario, scenarios: Object.fromEntries(Object.entries(SCENARIOS).map(([k, v]) => [k, v.description])), scenario_skus: SCENARIO_SKUS }),
  );

  app.post('/__mock/reset', async (c) => {
    let body: { scenario?: unknown; now?: unknown } = {};
    const text = await c.req.text();
    if (text.trim()) {
      try {
        body = JSON.parse(text) as typeof body;
      } catch {
        return fail(c, 400, 'invalid_json', 'body must be JSON');
      }
    }
    const scenario = body.scenario ?? state.ds.scenario;
    if (typeof scenario !== 'string' || !isScenario(scenario)) return fail(c, 400, 'unknown_scenario', `scenario must be one of ${Object.keys(SCENARIOS).join(', ')}`);
    let now = anchor();
    if (body.now !== undefined) {
      if (typeof body.now !== 'string' || Number.isNaN(Date.parse(body.now))) return fail(c, 400, 'invalid_now', 'now must be an ISO date');
      now = new Date(body.now);
    }
    state.ds = buildDataset(scenario, now);
    return c.json({ ok: true, scenario, latest_week: state.ds.weekStarts.at(-1) });
  });

  app.notFound((c) => fail(c, 404, 'not_found', 'Not Found'));

  return {
    app,
    get scenario() {
      return state.ds.scenario;
    },
    reset(scenario: ScenarioName = state.ds.scenario, now?: Date | string) {
      state.ds = buildDataset(scenario, now ? new Date(now) : anchor());
    },
  };
}

export type HeadsetMock = ReturnType<typeof createHeadsetMock>;
