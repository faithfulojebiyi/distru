import { describe, expect, test } from 'bun:test';
import { DAY, MINUTE, NOW, setup } from './setup';

const STREAMS = ['companies', 'products', 'purchases', 'orders'] as const;

describe('Distru incremental sync', () => {
  test('first run is a full load; cursors start at the run start; full load is rate-budgeted', async () => {
    const env = setup();
    const before = env.bucketRemaining();
    const res = await env.sync.run();
    expect(res.status).toBe('ok');
    const state = await env.mockState();
    for (const s of STREAMS) {
      expect(res.streams[s]!.stats!.mode).toBe('full');
      expect(res.streams[s]!.stats!.lowerBound).toBeNull();
      expect(res.streams[s]!.cursorAt).toBe(NOW); // no Date header → clock
    }
    expect((await env.store.list('product')).length).toBe(state.counts.products);
    expect((await env.store.list('company')).length).toBe(state.counts.companies);
    // purchases include the DRAFT (all statuses requested explicitly)
    expect((await env.store.list('purchase')).length).toBe(state.counts.purchases);
    expect((await env.store.list('order')).length).toBe(state.counts.orders);
    expect((await env.store.list('purchase')).some((p) => p.status === 'DRAFT')).toBe(true);
    // the full load costs one list call per page; the observer saw the bucket shrink
    const paid = STREAMS.reduce((n, s) => n + res.streams[s]!.stats!.paidPages, 0);
    expect(paid).toBeGreaterThan(30);
    expect(env.bucketRemaining()).toBe(before - paid);
    expect(env.observer.rateLimit.remaining).toBe(before - paid);
    // stock comes from /inventory, grouped by product + location
    const inv = await env.store.latestInventory('distru');
    expect(inv!.rows.length).toBeGreaterThan(40);
    expect(res.inventory!.rows).toBe(inv!.rows.length);
    // completed purchases got an estimated receipt time
    const completed = (await env.store.list('purchase')).filter((p) => p.status === 'COMPLETED');
    expect(completed.every((p) => p.receivedAt && p.receivedAtSource === 'updated_datetime')).toBe(true);
  });

  test('uses the Date header of the first response as the start time when present', async () => {
    const serverNow = '2026-11-19T11:59:58.000Z';
    const env = setup({ dateHeader: () => new Date(serverNow).toUTCString() });
    const res = await env.sync.run();
    expect(res.streams.products!.cursorAt).toBe(serverNow);
  });

  test('later runs fetch only recent changes, for free, and propagate deletes via /deleted-records', async () => {
    const env = setup();
    await env.sync.run();
    const bucketAfterFull = env.bucketRemaining();

    // quiet period: nothing changed
    env.clock.advance(10 * MINUTE);
    env.net.calls.length = 0;
    const quiet = await env.sync.run();
    expect(quiet.status).toBe('ok');
    for (const s of STREAMS) {
      const st = quiet.streams[s]!.stats!;
      expect(st.mode).toBe('incremental');
      expect(st.lowerBound).toBe(new Date(Date.parse(NOW) - 5 * MINUTE).toISOString());
      expect(st.fetched).toBe(0);
      expect(st.paidPages).toBe(0);
    }
    // every list call carried `updated_datetime=<prev start − 5 min>,` and nothing else (purchases: all statuses)
    const lists = env.net.calls.filter((c) => /\/(companies|products|purchases|orders)$/.test(c.path));
    expect(lists.length).toBe(4);
    for (const c of lists) expect(c.search).toContain('updated_datetime=2026-11-19T11:55:00.000Z,');
    expect(env.net.calls.filter((c) => c.path.endsWith('/deleted-records')).length).toBe(4);
    // free: the bucket only refilled (5/min × 10 min), nothing was taken
    expect(env.bucketRemaining()).toBe(Math.min(3000, bucketAfterFull + 50));

    // changes: a new order, a re-priced product, a deleted PO, a deleted product
    env.clock.advance(MINUTE);
    const order = await env.simulateOrder();
    const products = [...env.mock.store.products.values()];
    const repriced = products.find((p) => p.sku === 'PRE-BD-1G')!;
    env.mock.ops.saveProduct(structuredClone(repriced), { ...structuredClone(repriced), unit_price: 9.5 }, 'PUBLIC_API');
    const doomedProduct = products.find((p) => p.sku === 'ACC-BAT-SLV')!;
    env.mock.ops.saveProduct(structuredClone(doomedProduct), null, 'PUBLIC_API');
    const openPo = [...env.mock.store.purchases.values()].find((p) => p.status === 'PENDING')!;
    expect(env.mock.ops.deletePurchase(openPo.id, 'PUBLIC_API').ok).toBe(true);

    env.clock.advance(MINUTE);
    const changed = await env.sync.run();
    expect(changed.status).toBe('ok');
    expect(changed.streams.orders!.stats!.fetched).toBe(1);
    expect(changed.streams.products!.stats!.fetched).toBe(1);
    expect(changed.streams.products!.stats!.deleted).toBe(1);
    expect(changed.streams.purchases!.stats!.deleted).toBe(1);
    expect(STREAMS.every((s) => changed.streams[s]!.stats!.paidPages === 0)).toBe(true);

    expect((await env.store.list('order', { ids: [order.id] })).length).toBe(1);
    expect((await env.store.list('product', { ids: [repriced.id] }))[0]!.unitPrice).toBe(9.5);
    expect(await env.store.list('product', { ids: [doomedProduct.id] })).toEqual([]);
    expect((await env.store.list('product', { ids: [doomedProduct.id], includeDeleted: true }))[0]!.deletedAt).not.toBeNull();
    expect(await env.store.list('purchase', { ids: [openPo.id] })).toEqual([]);
  });

  test('a failing stream keeps its cursor; the next run resumes from it', async () => {
    const env = setup();
    await env.sync.run();
    env.clock.advance(30 * MINUTE);
    const order = await env.simulateOrder();
    env.net.failPath = '/public/v1/orders';
    const failed = await env.sync.run();
    expect(failed.status).toBe('failed');
    expect(failed.streams.orders!.status).toBe('failed');
    expect(failed.streams.purchases!.status).toBe('ok');
    expect((await env.store.getCursor('distru', 'orders'))!.cursorAt).toBe(NOW); // not advanced
    expect((await env.store.getCursor('distru', 'purchases'))!.cursorAt).toBe(new Date(Date.parse(NOW) + 30 * MINUTE).toISOString());
    expect((await env.store.list('order', { ids: [order.id] })).length).toBe(0);
    expect((await env.store.listSyncRuns(1))[0]!.status).toBe('failed');

    env.net.failPath = null;
    env.clock.advance(MINUTE);
    const retry = await env.sync.run();
    expect(retry.status).toBe('ok');
    expect(retry.streams.orders!.stats!.lowerBound).toBe(new Date(Date.parse(NOW) - 5 * MINUTE).toISOString());
    expect((await env.store.list('order', { ids: [order.id] })).length).toBe(1);
  });

  test('low list budget: backs off and defers paid calls without advancing the cursor', async () => {
    const env = setup({ minRateRemaining: 100, maxBackoffMs: 60_000 });
    await env.configureMock({ rate_limit: { list: { tokens: 50 } } });
    const res = await env.sync.run();
    expect(res.status).toBe('deferred');
    expect(res.streams.companies!.status).toBe('ok'); // one page, no further paid call needed
    expect(res.streams.products!.status).toBe('deferred');
    expect(res.retryAfterMs).toBeGreaterThan(60_000);
    expect(await env.store.getCursor('distru', 'products')).toBeNull();
    expect(res.streams.orders!.status).toBe('skipped');
  });

  test('429 from Distru defers the run with Retry-After', async () => {
    const env = setup();
    await env.configureMock({ rate_limit: { fail_next: 1, retry_after: 7 } });
    const res = await env.sync.run();
    expect(res.status).toBe('deferred');
    expect(res.retryAfterMs).toBe(7000);
    expect(await env.store.getCursor('distru', 'companies')).toBeNull();
  });

  test('a lower bound older than 30 days is rate-budgeted; within 30 days it is free', async () => {
    const env = setup({ reconcileEveryMs: null });
    await env.sync.run();
    env.clock.advance(29 * DAY);
    const free = await env.sync.run();
    expect(STREAMS.every((s) => free.streams[s]!.stats!.paidPages === 0)).toBe(true);
    env.clock.advance(31 * DAY);
    const paid = await env.sync.run();
    expect(paid.streams.orders!.stats!.paidPages).toBeGreaterThan(0);
  });

  test('weekly reconcile removes rows the source no longer returns', async () => {
    const env = setup();
    await env.sync.run();
    const victim = [...env.mock.store.companies.values()].find((c) => c.relationship === 'Customer')!;
    env.mock.store.companies.delete(victim.id); // gone without a deleted-records entry
    env.clock.advance(DAY);
    const daily = await env.sync.run();
    expect(daily.streams.companies!.stats!.mode).toBe('incremental');
    expect((await env.store.list('company', { ids: [victim.id] })).length).toBe(1);
    env.clock.advance(7 * DAY);
    const weekly = await env.sync.run();
    expect(weekly.streams.companies!.stats!.mode).toBe('reconcile');
    expect(weekly.streams.companies!.stats!.deleted).toBe(1);
    expect((await env.store.list('company', { ids: [victim.id] })).length).toBe(0);
    expect((await env.store.getCursor('distru', 'companies'))!.lastFullAt).toBe(env.clock.now().toISOString());
  });

  test('webhook partial sync: get-by-id, dedupe on (type, id, occurred_datetime), 404 → delete, PRODUCT refreshes stock', async () => {
    const env = setup();
    await env.sync.run();
    env.clock.advance(MINUTE);
    const order = await env.simulateOrder();
    const occurred = env.clock.now().toISOString();
    const first = await env.sync.handleWebhook({ type: 'ORDER', event: 'CREATE', id: order.id, object: { evil: 'ignored' }, occurred_datetime: occurred });
    expect(first.status).toBe('upserted');
    expect((await env.store.list('order', { ids: [order.id] })).length).toBe(1);
    const replay = await env.sync.syncRecord('ORDER', order.id, occurred);
    expect(replay.status).toBe('duplicate');

    const po = [...env.mock.store.purchases.values()].find((p) => p.status === 'PENDING')!;
    env.mock.ops.deletePurchase(po.id, 'PUBLIC_API');
    expect((await env.sync.syncRecord('PURCHASE', po.id, occurred)).status).toBe('deleted');
    expect(await env.store.list('purchase', { ids: [po.id] })).toEqual([]);

    const product = [...env.mock.store.products.values()].find((p) => p.sku === 'FLW-BD-35')!;
    const lot = [...env.mock.store.lots.values()].find((l) => l.product_id === product.id && l.quantity > 0)!;
    lot.quantity += 100;
    const before = (await env.store.latestInventory('distru'))!.rows.filter((r) => r.productId === product.id).reduce((s, r) => s + r.active, 0);
    expect((await env.sync.syncRecord('PRODUCT', product.id, occurred)).status).toBe('upserted');
    const after = (await env.store.latestInventory('distru'))!.rows.filter((r) => r.productId === product.id).reduce((s, r) => s + r.active, 0);
    expect(after).toBe(before + 100);
    expect((await env.sync.syncRecord('INVOICE', 'x')).status).toBe('ignored');
  });
});
