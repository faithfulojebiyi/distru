/** The Distru mock in-process (no network), a fake clock shared by the mock and the sync, and an in-memory context store. */
import { createDistruClient, type FetchLike } from '@ops/distru-client';
import { createMockServer } from '@ops/distru-mock';
import { FakeClock } from '@ops/harness';
import { createDistruObserver, createDistruSync, InMemoryContextStore, type DistruSyncOptions } from '../src';

export const NOW = '2026-11-19T12:00:00.000Z';
/** Seed anchored a day earlier so no seeded record is dated after NOW (the seed anchors to the UTC day). */
export const SEED_ANCHOR = '2026-11-18T12:00:00.000Z';

export interface SetupOptions extends Partial<Omit<DistruSyncOptions, 'client' | 'store' | 'clock' | 'observer'>> {
  /** Add a `Date` response header (the mock, like `app.request`, sends none). */
  dateHeader?: () => string | null;
}

export function setup(opts: SetupOptions = {}) {
  const clock = new FakeClock(NOW);
  const mock = createMockServer({ now: SEED_ANCHOR, clock: () => clock.now().getTime() });
  const pinMockTime = () => {
    mock.store.nowIso = () => clock.now().toISOString();
  };
  pinMockTime();
  const net = {
    /** Next requests whose path starts with this get a 500. */
    failPath: null as string | null,
    calls: [] as { path: string; search: string }[],
  };
  const baseFetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    net.calls.push({ path: u.pathname, search: decodeURIComponent(u.search) });
    if (net.failPath && u.pathname.startsWith(net.failPath)) {
      return new Response(JSON.stringify({ errors: [{ message: 'upstream exploded', pointer: ['base'] }] }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    const res = await mock.app.request(url, init);
    const date = opts.dateHeader?.();
    if (!date) return res;
    const headers = new Headers(res.headers);
    headers.set('Date', date);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
  const observer = createDistruObserver();
  const client = createDistruClient({ baseUrl: 'http://mock.test', token: 'mock-token', fetch: observer.wrap(baseFetch), maxRetries: 0 });
  const store = new InMemoryContextStore();
  const { dateHeader: _d, ...syncOpts } = opts;
  const sync = createDistruSync({ client, store, clock, observer, ...syncOpts });
  const configureMock = async (body: unknown) => {
    const res = await mock.app.request('/__mock/config', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    if (!res.ok) throw new Error(`mock config failed: ${res.status} ${await res.text()}`);
  };
  const mockState = async () =>
    (await (await mock.app.request('/__mock/state')).json()) as {
      vendors: { id: string; name: string; typical_lead_time_days: number }[];
      counts: { companies: number; products: number; purchases: number; orders: number };
    };
  const simulateOrder = async (body: unknown = {}) => {
    const res = await mock.app.request('/__mock/simulate/order', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    if (!res.ok) throw new Error(`simulate order failed: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { data: { id: string } }).data;
  };
  const bucketRemaining = () => mock.restLimiter.bucket.remaining();
  return { clock, mock, net, observer, client, store, sync, configureMock, mockState, simulateOrder, bucketRemaining, pinMockTime };
}

export type Env = ReturnType<typeof setup>;

export const MINUTE = 60_000;
export const DAY = 86_400_000;
