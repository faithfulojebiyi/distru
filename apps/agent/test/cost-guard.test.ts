/**
 * Cost guard: per-user hourly limit and global daily spend cap on the token-spending routes (Copilot
 * stream/generate, POST /api/runs, A2A), 429 with a friendly JSON message; spend comes from every agent's
 * finished-call usage, priced like the run budgets.
 */
import { describe, expect, test } from 'bun:test';
import { Mastra } from '@mastra/core';
import { InMemoryStore } from '@mastra/core/storage';
import { Hono } from 'hono';
import { costGuard, HourlyRateLimiter, isGuardedRequest, SpendLedger } from '../src/api/cost-guard';
import { createOpsLead } from '../src/mastra/agents/ops-lead';
import { createInventoryAnalyst } from '../src/mastra/agents/inventory-analyst';
import { scriptedModel, USAGE } from './fixtures/scripted-model';

const PRICING = { inputUsdPerMTok: 3, outputUsdPerMTok: 15 };

function clock(start = '2026-11-20T10:00:00Z') {
  let at = new Date(start).getTime();
  return { now: () => new Date(at), advance: (ms: number) => (at += ms) };
}

function app(options: { limit?: number; cap?: number | null; ledger?: SpendLedger; now?: () => Date } = {}) {
  const ledger = options.ledger ?? new SpendLedger(PRICING, options.now);
  const hono = new Hono();
  hono.use(
    '*',
    costGuard({
      limiter: options.limit ? new HourlyRateLimiter(options.limit, options.now) : null,
      ledger,
      dailyCapUsd: options.cap ?? null,
      callerOf: async (c) => {
        const who = c.req.header('authorization')?.replace('Bearer ', '');
        return who ? `user:${who}` : null;
      },
    }),
  );
  hono.post('/api/runs', (c) => c.json({ runId: 'r1' }, 202));
  hono.post('/api/agents/:agentId/stream', (c) => c.text('data: {}\n\n'));
  hono.post('/api/a2a/:agentId', (c) => c.json({ jsonrpc: '2.0', id: 1, result: {} }));
  hono.get('/api/runs', (c) => c.json({ items: [] }));
  const post = (path: string, as?: string) => hono.request(path, { method: 'POST', headers: as ? { authorization: `Bearer ${as}` } : {} });
  return { hono, ledger, post };
}

describe('rate limit', () => {
  test('N agent requests per user per hour, then 429 with Retry-After and a friendly message; per user; sliding window', async () => {
    const t = clock();
    const env = app({ limit: 3, now: t.now });
    expect((await env.post('/api/agents/ops-lead/stream', 'ana')).status).toBe(200);
    t.advance(10 * 60_000);
    expect((await env.post('/api/runs', 'ana')).status).toBe(202);
    t.advance(10 * 60_000);
    expect((await env.post('/api/a2a/ops-lead', 'ana')).status).toBe(200);
    const limited = await env.post('/api/agents/ops-lead/stream', 'ana');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = (await limited.json()) as { error: string; message: string };
    expect(body.error).toBe('rate_limited');
    expect(body.message).toContain('3 agent requests per hour');
    // Another user is unaffected; reads are never limited.
    expect((await env.post('/api/runs', 'ben')).status).toBe(202);
    expect((await env.hono.request('/api/runs')).status).toBe(200);
    // Rejected requests don't count: an hour after the first hit, one slot frees up.
    t.advance(40 * 60_000 + 1);
    expect((await env.post('/api/runs', 'ana')).status).toBe(202);
    expect((await env.post('/api/runs', 'ana')).status).toBe(429);
  });

  test('unauthenticated requests pass through (the route itself answers 401)', async () => {
    const env = app({ limit: 1 });
    for (let i = 0; i < 3; i++) expect((await env.post('/api/runs')).status).toBe(202);
  });

  test('guarded routes: POST only, agent stream/generate, runs, A2A', () => {
    expect(isGuardedRequest('POST', '/api/agents/ops-lead/generate')).toBe(true);
    expect(isGuardedRequest('POST', '/api/runs')).toBe(true);
    expect(isGuardedRequest('POST', '/api/a2a/ops-lead')).toBe(true);
    expect(isGuardedRequest('GET', '/api/runs')).toBe(false);
    expect(isGuardedRequest('POST', '/api/proposals/x/decision')).toBe(false);
    expect(isGuardedRequest('GET', '/api/memory/threads')).toBe(false);
  });
});

describe('daily spend cap', () => {
  test('once today\'s estimate reaches the cap, agent requests get 429 daily_spend_cap until UTC midnight', async () => {
    const t = clock('2026-11-20T23:00:00Z');
    const ledger = new SpendLedger(PRICING, t.now);
    const env = app({ cap: 1, ledger, now: t.now });
    expect((await env.post('/api/runs', 'ana')).status).toBe(202);
    // 200k input + 20k output tokens at $3 / $15 per Mtok = $0.60 + $0.30.
    ledger.addUsage({ inputTokens: 200_000, outputTokens: 20_000 });
    expect(ledger.spentToday()).toBeCloseTo(0.9, 6);
    expect((await env.post('/api/runs', 'ana')).status).toBe(202);
    ledger.addUsage({ inputTokens: 40_000, outputTokens: 0 });
    const capped = await env.post('/api/agents/ops-lead/stream', 'ben');
    expect(capped.status).toBe(429);
    expect(((await capped.json()) as { error: string }).error).toBe('daily_spend_cap');
    expect(Number(capped.headers.get('retry-after'))).toBe(3600);
    // A new UTC day starts from zero.
    t.advance(60 * 60_000);
    expect(ledger.spentToday()).toBe(0);
    expect((await env.post('/api/runs', 'ana')).status).toBe(202);
  });

  test('prompt-cache reads are priced like the run budgets (0.1x input)', () => {
    const ledger = new SpendLedger(PRICING);
    ledger.addUsage({ inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 });
    expect(ledger.spentToday()).toBeCloseTo(0.3, 6);
    ledger.addUsage(undefined);
    ledger.addUsage({ inputTokens: 'x' });
    expect(ledger.spentToday()).toBeCloseTo(0.3, 6);
  });

  test('agents report every finished call: the Ops Lead (Copilot / A2A) and the specialists', async () => {
    const ledger = new SpendLedger(PRICING);
    const onUsage = (usage: unknown) => ledger.addUsage(usage);
    const opsLead = createOpsLead({ model: scriptedModel('opsLead', () => ({ text: 'ok' })), tools: {}, agents: {}, onUsage });
    const analyst = createInventoryAnalyst({ model: scriptedModel('inventoryAnalyst', () => ({ text: 'ok' })), tools: {}, onUsage });
    new Mastra({ agents: { opsLead, analyst }, storage: new InMemoryStore(), logger: false });
    await opsLead.generate('Anything at risk?', { memory: { thread: 't1', resource: 'u1' } });
    await analyst.generate('Analyse Oakland');
    // Workflow calls (callAgent) pass their own options; the default onFinish still runs.
    await analyst.generate('Analyse LA', { maxSteps: 2, onStepFinish: () => undefined });
    const perCall = (USAGE.inputTokens * 3 + USAGE.outputTokens * 15) / 1_000_000;
    expect(ledger.spentToday()).toBeCloseTo(3 * perCall, 6);
  });
});
