/**
 * GET /api/evals, /api/evals/{scenario}/history, /api/context/profile, /api/context/memories and
 * /api/onboarding: session required, typed responses, named OpenAPI components. Plus the Postgres
 * query behind /api/evals (latest row per scenario) on the test database.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { inArray } from 'drizzle-orm';
import postgres from 'postgres';
import { createApiRoutes } from '../src/api/routes';
import type { EvalResult } from '../src/api/schemas-insight';
import type { ApiServices } from '../src/api/services';
import type { SessionUser } from '../src/auth/session';
import { db } from '../src/db/client';
import { evalRun } from '../src/db/schema';
import { createEvalsService } from '../src/services/evals';
import { stubServices } from './fixtures/stub-services';

const operator: SessionUser = { id: 'u-op', email: 'operator@demo.dev', name: 'Op', role: 'operator' };
const row = (scenario: string, passed: boolean, at: string): EvalResult => ({ id: crypto.randomUUID(), batchId: 'b1', scenario, passed, scores: { pass_rate: passed ? 1 : 0.5 }, details: { title: scenario }, createdAt: at });

function setup(overrides: Partial<ApiServices> = {}) {
  const services: ApiServices = {
    resolveSession: async (h) => (h.get('authorization') === 'Bearer op' ? operator : null),
    checkDatabase: async () => true,
    proposals: { list: async () => [], get: async () => null, decide: async () => Promise.reject(new Error('unused')) },
    audit: { list: async () => [] },
    ...stubServices(),
    ...overrides,
  };
  const api = createApiRoutes(services);
  return (path: string, auth = true) => api.request(path, { headers: auth ? { authorization: 'Bearer op' } : {} });
}

describe('insight routes', () => {
  test('evals: latest + history; 401 without a session', async () => {
    const calls: unknown[] = [];
    const get = setup({
      evals: {
        latest: async () => [row('a', true, '2026-11-19T10:00:00.000Z')],
        history: async (scenario, limit) => {
          calls.push([scenario, limit]);
          return [row(scenario, false, '2026-11-19T09:00:00.000Z')];
        },
      },
    });
    expect((await get('/api/evals', false)).status).toBe(401);
    expect(await (await get('/api/evals')).json()).toMatchObject({ items: [{ scenario: 'a', passed: true }] });
    const h = await get('/api/evals/no-reorder-needed/history?limit=5');
    expect(await h.json()).toMatchObject({ scenario: 'no-reorder-needed', items: [{ passed: false }] });
    expect(calls).toEqual([['no-reorder-needed', 5]]);
  });

  test('context profile / memories / onboarding', async () => {
    const get = setup({
      context: {
        profile: async () => ({ available: false, version: null, computedAt: null, source: null, counts: null, vendors: [], products: [], sync: { lastRunAt: null, lastStatus: null, cursors: [] } }),
        memories: async (q) => [
          { id: 'm1', scope: q.scope ?? 'global', scopeId: null, key: 'policy:max_total_value', statement: 'raised', evidence: { proposalIds: [], auditIds: ['a1'], refs: [] }, evidenceCount: 1, confidence: 1, origin: 'learned', status: 'active', data: {}, createdAt: 'x', lastConfirmedAt: 'x', expiresAt: null, effectiveConfidence: 0.9 },
        ],
        onboarding: async () => ({
          generatedAt: '2026-11-19T00:00:00.000Z',
          completeness: {
            score: 0.8,
            products: { total: 1, active: 1, withSku: 1, withVendor: 1, withCost: 1 },
            companies: { vendors: 1, customers: 1, other: 0 },
            purchases: { total: 1, completed: 1, withOrderDate: 1, withReceipt: 1, from: null, to: null },
            orders: { total: 1, withLines: 1, from: null, to: null, historyDays: 30 },
            inventory: { snapshotAt: null, rows: 0 },
            issues: [],
          },
          vendorsMissingLeadTimes: [],
          suggestedPolicy: [],
        }),
      },
    });
    expect((await get('/api/context/profile', false)).status).toBe(401);
    expect(await (await get('/api/context/profile')).json()).toMatchObject({ available: false, vendors: [] });
    expect(await (await get('/api/context/memories?scope=global')).json()).toMatchObject({ items: [{ key: 'policy:max_total_value', effectiveConfidence: 0.9 }] });
    expect(await (await get('/api/onboarding')).json()).toMatchObject({ completeness: { score: 0.8 } });
  });

  test('OpenAPI: paths and named schemas', async () => {
    const doc = (await (await setup()('/api/openapi.json', false)).json()) as { paths: Record<string, unknown>; components: { schemas: Record<string, unknown> } };
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/api/evals', '/api/evals/{scenario}/history', '/api/context/profile', '/api/context/memories', '/api/onboarding', '/api/proposals/{id}/resume']));
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining(['EvalResult', 'EvalList', 'EvalHistory', 'ContextProfile', 'ContextMemory', 'ContextMemoryList', 'OnboardingReport', 'ResumeRequest', 'ResumeResponse', 'NotResumableResponse']),
    );
  });
});

async function reachable(): Promise<boolean> {
  const probe = postgres(process.env.DATABASE_URL!, { max: 1, connect_timeout: 2, onnotice: () => {} });
  try {
    await probe`select 1 from eval_run limit 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 1 }).catch(() => {});
  }
}
const ok = await reachable();
const scenarios = [`it-a-${crypto.randomUUID()}`, `it-b-${crypto.randomUUID()}`];
afterAll(async () => {
  if (ok) await db.delete(evalRun).where(inArray(evalRun.scenario, scenarios));
});

describe.skipIf(!ok)('evals service (Postgres)', () => {
  test('latest row per scenario; history newest first', async () => {
    const [a, b] = scenarios as [string, string];
    await db.insert(evalRun).values([
      { scenario: a, scores: { pass_rate: 0.5 }, passed: false, batchId: 'b1', details: {}, createdAt: new Date('2026-11-18T10:00:00Z') },
      { scenario: a, scores: { pass_rate: 1 }, passed: true, batchId: 'b2', details: {}, createdAt: new Date('2026-11-19T10:00:00Z') },
      { scenario: b, scores: { pass_rate: 1 }, passed: true, batchId: 'b1', details: {}, createdAt: new Date('2026-11-18T10:00:00Z') },
    ]);
    const evals = createEvalsService(db);
    const latest = (await evals.latest()).filter((r) => scenarios.includes(r.scenario));
    expect(latest.map((r) => [r.scenario, r.batchId])).toEqual([
      [a, 'b2'],
      [b, 'b1'],
    ]);
    expect((await evals.history(a, 10)).map((r) => r.batchId)).toEqual(['b2', 'b1']);
  });
});
