import '../src/env-defaults';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scenarioById } from '../src/scenarios';
import { MemorySink } from '../src/sink';
import { runSuite } from '../src/suite';
import type { Scenario } from '../src/scenario';

/**
 * End to end, offline: the real agents, workflow, harness, connectors and mocks, with every model
 * call answered from the committed recordings by the LLM emulator. Any request leaving the machine
 * fails the test (only the local LLM gateway on 127.0.0.1 is allowed).
 */
const realFetch = globalThis.fetch;
const outbound: string[] = [];

beforeAll(() => {
  const guarded = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
        outbound.push(url.href);
        throw new Error(`network access in an offline eval: ${url.href}`);
      }
      return realFetch(input, init);
    },
    { preconnect: realFetch.preconnect },
  );
  globalThis.fetch = guarded;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

const scenario = (id: string): Scenario => {
  const s = scenarioById(id);
  if (!s) throw new Error(`no scenario ${id}`);
  return s;
};

describe('offline replay (no network, no key, no spend)', () => {
  test('failed lab test veto + Copilot lead-time question pass from their recordings', async () => {
    const sink = new MemorySink();
    const report = await runSuite({
      mode: 'offline',
      scenarios: [scenario('failed-lab-test-veto'), scenario('copilot-longest-lead-time')],
      judge: true,
      config: { model: 'claude-sonnet-5-5', pricing: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 } },
      sinks: [sink],
    });
    expect(outbound).toEqual([]);
    expect(report.totals.realCostUsd).toBe(0);
    for (const r of report.scenarios) {
      const failing = r.assertions.filter((a) => a.status !== 'pass').map((a) => `${a.label}: ${a.detail}`);
      expect({ id: r.id, status: r.status, reason: r.reason, failing }).toEqual({ id: r.id, status: 'pass', reason: null, failing: [] });
      expect(r.realCalls).toBe(0);
      expect(r.usage.llmCalls).toBeGreaterThan(0);
    }
    const [veto] = report.scenarios;
    expect(veto?.observation?.vetoed.some((v) => v.sku === 'FLW-WC-35')).toBe(true);
    expect(sink.reports).toHaveLength(1);
  }, 120_000);

  test('a missing recording is reported, not silently answered', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evals-empty-'));
    try {
      const report = await runSuite({
        mode: 'offline',
        scenarios: [scenario('copilot-overdue-invoices')],
        judge: false,
        recordingsDir: dir,
        config: { model: 'claude-sonnet-5-5', pricing: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 } },
      });
      expect(report.scenarios[0]?.status).toBe('missing_recording');
      expect(report.totals.missingRecording).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
