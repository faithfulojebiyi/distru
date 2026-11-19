import '../src/env-defaults';
import { existsSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { recordingPath } from '../src/runner';
import { ScenarioSchema } from '../src/scenario';
import { SCENARIOS } from '../src/scenarios';
import { toEvalRunRow } from '../src/sink';
import { buildReport, reportFailed } from '../src/report';
import { RECORDINGS_DIR } from '../src/suite';
import type { ScenarioResult } from '../src/runner';

const base = {
  id: 'x',
  title: 'X',
  description: 'why',
  mockScenario: 'default',
  trigger: { kind: 'restock' },
  expectations: [{ kind: 'writes', resource: 'purchases', count: 0 }],
};

describe('scenario schema', () => {
  test('every shipped scenario parses, ids are unique, ready ones have a recording', () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SCENARIOS) {
      expect(ScenarioSchema.safeParse(s).success).toBe(true);
      if (s.status === 'ready' && s.trigger.kind !== 'vendor_reply') expect(existsSync(recordingPath(RECORDINGS_DIR, s.recording ?? s.id))).toBe(true);
    }
  });

  test('defaults: ready, no policy overrides, empty scope', () => {
    const s = ScenarioSchema.parse(base);
    expect(s.status).toBe('ready');
    expect(s.emulatorSetup).toEqual({ policyRules: [], distruMockConfig: [] });
    expect(s.scope).toEqual({ locations: [] });
    expect(s.trigger).toEqual({ kind: 'restock', approve: false, reexecute: false });
  });

  test('rejects bad ids, unknown mock scenarios and unknown assertion kinds', () => {
    expect(ScenarioSchema.safeParse({ ...base, id: 'Has Spaces' }).success).toBe(false);
    expect(ScenarioSchema.safeParse({ ...base, mockScenario: 'nope' }).success).toBe(false);
    expect(ScenarioSchema.safeParse({ ...base, expectations: [{ kind: 'vibes_ok' }] }).success).toBe(false);
    expect(ScenarioSchema.safeParse({ ...base, expectations: [] }).success).toBe(false);
  });

  test('pending needs a reason', () => {
    expect(ScenarioSchema.safeParse({ ...base, status: 'pending' }).success).toBe(false);
    expect(ScenarioSchema.safeParse({ ...base, status: 'pending', pendingReason: 'not built yet' }).success).toBe(true);
  });

  test('answer assertions need a copilot trigger; execution assertions need approve (+ reexecute)', () => {
    expect(ScenarioSchema.safeParse({ ...base, expectations: [{ kind: 'answer_mentions', patterns: ['x'] }] }).success).toBe(false);
    expect(ScenarioSchema.safeParse({ ...base, trigger: { kind: 'copilot', question: 'q?' }, expectations: [{ kind: 'answer_mentions', patterns: ['x'] }] }).success).toBe(true);
    expect(ScenarioSchema.safeParse({ ...base, expectations: [{ kind: 'verify_all_ok' }] }).success).toBe(false);
    expect(ScenarioSchema.safeParse({ ...base, trigger: { kind: 'restock', approve: true }, expectations: [{ kind: 'verify_all_ok' }] }).success).toBe(true);
    expect(ScenarioSchema.safeParse({ ...base, trigger: { kind: 'restock', approve: true }, expectations: [{ kind: 'idempotent_reexecute' }] }).success).toBe(false);
  });
});

describe('report + eval_run mapping', () => {
  const result = (id: string, status: ScenarioResult['status']): ScenarioResult => ({
    id,
    title: id,
    status,
    reason: null,
    mode: 'offline',
    model: 'claude-sonnet-5-5',
    assertions: [
      { kind: 'writes', label: 'w', status: status === 'pass' ? 'pass' : 'fail', detail: '', score: status === 'pass' ? 1 : 0 },
      { kind: 'llm_judge', label: 'j', status: 'pass', detail: '', score: 1 },
    ],
    passed: status === 'pass' ? 2 : 1,
    failed: status === 'pass' ? 0 : 1,
    usage: { llmCalls: 3, inputTokens: 100, outputTokens: 10, costUsd: 0.01 },
    realCalls: 0,
    latencyMs: 12,
    observation: null,
  });

  test('pending and missing recordings are not stored; scores carry pass rate, cost, tokens and judge', () => {
    const report = buildReport({ batchId: 'b1', startedAt: new Date(0), mode: 'offline', model: 'm', judge: true, gitSha: 'abc', realCostUsd: 0, scenarios: [result('a', 'pass'), result('b', 'fail'), result('c', 'pending'), result('d', 'missing_recording')] });
    expect(report.totals).toMatchObject({ scenarios: 4, passed: 1, failed: 1, pending: 1, missingRecording: 1 });
    expect(reportFailed(report)).toBe(true);
    const rows = report.scenarios.map((r) => toEvalRunRow(report, r));
    expect(rows.map((r) => r?.scenario ?? null)).toEqual(['a', 'b', null, null]);
    expect(rows[0]).toMatchObject({ batch_id: 'b1', passed: true, scores: { pass_rate: 1, cost_usd: 0.01, input_tokens: 100, judge: 1 } });
    expect(rows[1]?.scores.pass_rate).toBe(0.5);
    expect(rows[0]?.details).toMatchObject({ model: 'claude-sonnet-5-5', gitSha: 'abc', mode: 'offline' });
  });

  test('a clean report passes; missing recordings fail unless allowed', () => {
    const clean = buildReport({ batchId: 'b', startedAt: new Date(0), mode: 'offline', model: 'm', judge: false, gitSha: null, realCostUsd: 0, scenarios: [result('a', 'pass'), result('c', 'pending')] });
    expect(reportFailed(clean)).toBe(false);
    const missing = buildReport({ batchId: 'b', startedAt: new Date(0), mode: 'offline', model: 'm', judge: false, gitSha: null, realCostUsd: 0, scenarios: [result('d', 'missing_recording')] });
    expect(reportFailed(missing)).toBe(true);
    expect(reportFailed(missing, { allowMissing: true })).toBe(false);
  });
});
