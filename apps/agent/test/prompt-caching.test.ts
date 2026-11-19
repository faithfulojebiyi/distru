/**
 * Prompt caching: every agent's system prompt carries an Anthropic cache breakpoint (which also caches
 * the tool definitions rendered before it), agent calls request automatic caching for the loop, and
 * cache reads / writes are recorded and priced in the run totals.
 */
import { describe, expect, test } from 'bun:test';
import { ANTHROPIC_CACHE } from '../src/mastra/agents/shared';
import { cacheUsageOf } from '../src/mastra/workflows/agent-call';
import { estimateCostUsd, sumTrace, type AgentTraceEntry } from '../src/mastra/trace';
import { restockEnv } from './fixtures/restock-env';

describe('prompt caching', () => {
  test('every agent system prompt is a cached system message', async () => {
    const env = await restockEnv();
    for (const agent of Object.values(env.agents)) {
      const instructions = await agent.getInstructions();
      expect(instructions).toMatchObject({ role: 'system', providerOptions: ANTHROPIC_CACHE });
    }
  });

  test('usage: inputTokens includes cache reads/writes; cost prices them at 0.1× / 1.25×', () => {
    // Shape reported by Mastra 1.85 for an Anthropic step (from a live call).
    const usage = cacheUsageOf({ inputTokens: 13_688, outputTokens: 17, totalTokens: 13_705, cachedInputTokens: 13_623, cacheCreationInputTokens: 63 });
    expect(usage).toEqual({ input: 13_688, output: 17, total: 13_705, cacheRead: 13_623, cacheWrite: 63 });
    const pricing = { inputUsdPerMTok: 3, outputUsdPerMTok: 15 };
    const cached = estimateCostUsd(usage, pricing);
    const uncached = estimateCostUsd({ input: usage.input, output: usage.output }, pricing);
    // 2 uncached + 13,623 × 0.1 + 63 × 1.25 = 1,443.05 input-equivalents.
    expect(cached).toBeCloseTo((1443.05 * 3 + 17 * 15) / 1_000_000, 5);
    expect(cached).toBeLessThan(uncached / 5);
  });

  test('run totals sum cache reads and writes (old entries without them count as 0)', () => {
    const base = { agent: 'a', agentName: 'A', step: 's', label: 'l', round: null, status: 'success' as const, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), toolCalls: [], summary: null, error: null };
    const entries: AgentTraceEntry[] = [
      { ...base, tokens: { input: 100, output: 10, total: 110, cacheRead: 80, cacheWrite: 10 }, costUsd: 0.001 },
      { ...base, tokens: { input: 50, output: 5, total: 55, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.002 },
    ];
    expect(sumTrace(entries).tokens).toEqual({ input: 150, output: 15, total: 165, cacheRead: 80, cacheWrite: 10 });
  });
});
