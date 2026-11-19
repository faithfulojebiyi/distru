/**
 * DrizzleContextStore against a real Postgres. Opt-in: set CONTEXT_PG_TEST=1 (uses DATABASE_URL or
 * the docker-compose default). Creates a throwaway database, applies the `context` schema generated
 * from ./src/drizzle/schema.ts by drizzle-kit's API, runs sync → profile → memories → retrieval,
 * then drops the database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { buildProfile, contextFor, createDistruSync, ingestHarnessEvents, onboardingReport, remember } from '../src';
import { contextTables, DrizzleContextStore } from '../src/drizzle';
import { setup } from './setup';

const enabled = process.env.CONTEXT_PG_TEST === '1';
const adminUrl = process.env.DATABASE_URL ?? 'postgres://ops:ops@127.0.0.1:5482/ops';
const dbName = `ops_context_test_${process.pid}`;

describe.skipIf(!enabled)('DrizzleContextStore (Postgres)', () => {
  let admin: postgres.Sql;
  let sql: postgres.Sql;

  beforeAll(async () => {
    admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${dbName}`);
    const url = new URL(adminUrl);
    url.pathname = `/${dbName}`;
    sql = postgres(url.toString(), { max: 4, onnotice: () => {} });
    const empty = generateDrizzleJson({});
    const statements = await generateMigration(empty, generateDrizzleJson(contextTables, empty.id, ['context']));
    for (const s of statements) await sql.unsafe(s);
  });

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin?.end();
  });

  test('sync, profile, memories and retrieval round-trip through Postgres', async () => {
    const env = setup();
    const store = new DrizzleContextStore(drizzle(sql));
    const sync = createDistruSync({ client: env.client, store, clock: env.clock, observer: env.observer });
    const first = await sync.run();
    expect(first.status).toBe('ok');
    const state = await env.mockState();
    expect((await store.list('order')).length).toBe(state.counts.orders);
    expect((await store.list('purchase')).length).toBe(state.counts.purchases);
    expect((await store.getCursor('distru', 'orders'))!.cursorAt).toBe('2026-11-19T12:00:00.000Z');
    expect((await store.latestInventory('distru'))!.rows.length).toBe(first.inventory!.rows);

    env.clock.advance(60_000);
    const order = await env.simulateOrder();
    const po = [...env.mock.store.purchases.values()].find((p) => p.status === 'PENDING')!;
    env.mock.ops.deletePurchase(po.id, 'PUBLIC_API');
    env.clock.advance(60_000);
    const second = await sync.run();
    expect(second.streams.orders!.stats!.fetched).toBe(1);
    expect(second.streams.purchases!.stats!.deleted).toBe(1);
    expect((await store.list('order', { ids: [order.id] }))[0]!.lines.length).toBeGreaterThan(0);
    expect(await store.list('purchase', { ids: [po.id] })).toEqual([]);
    expect((await sync.syncRecord('ORDER', order.id, '2026-11-19T12:01:00Z')).status).toBe('upserted');
    expect((await sync.syncRecord('ORDER', order.id, '2026-11-19T12:01:00Z')).status).toBe('duplicate');

    const profile = await buildProfile(store, { clock: env.clock });
    expect(profile.version).toBe(1);
    for (const v of state.vendors) expect(Math.round(profile.vendors.find((x) => x.vendorId === v.id)!.actualLeadTimeDays!)).toBe(v.typical_lead_time_days);
    expect((await buildProfile(store, { clock: env.clock })).version).toBe(2);
    expect((await store.latestProfile())!.vendors.length).toBe(6);

    const mpr = profile.vendors.find((v) => v.name === 'Mojave Pre-Roll Co.')!;
    const at = env.clock.now().toISOString();
    await ingestHarnessEvents(
      store,
      [500, 300, 250].map((q, i) => ({
        id: `a${i}`,
        at,
        kind: 'decision',
        proposalId: `p${i}`,
        decision: 'approve',
        reason: null,
        edited: true,
        by: { kind: 'user', id: 'u1' },
        ops: [{ index: 0, action: 'x', vendorIds: [mpr.vendorId], proposed: [{ productId: 'p', quantity: q }], final: [{ productId: 'p', quantity: q * 0.8 }] }],
      })),
      { clock: env.clock },
    );
    await remember(store, { statement: 'Mojave ships Tuesdays', scope: 'vendor', scopeId: mpr.vendorId }, { clock: env.clock });
    const block = await contextFor(store, { vendorIds: [mpr.vendorId] }, { clock: env.clock });
    expect(block.text).toContain('Approver trims Mojave Pre-Roll Co. POs by ~20% (3 of 3 edits)');
    expect(block.text).toContain('Mojave ships Tuesdays');
    const report = await onboardingReport(store, { clock: env.clock });
    expect(report.suggestedPolicy.length).toBe(4);
  });
});
