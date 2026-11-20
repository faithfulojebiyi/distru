import { describe, expect, test } from 'bun:test';

import { foldRepeatedTools } from '../steps/step-activity-data';
import type { AgentStep, StepRow } from '../steps/step-types';
import { chatTitleOf, isChatId, runLabel } from './copilot-chats-data';
import { argsSummary, copilotErrorOfChunk, copilotErrorOfThrown, turnsOfHistory } from './copilot-data';

describe('chat titles', () => {
  test('short questions stay as they are; long ones cut at a word, ≤ 60 chars', () => {
    expect(chatTitleOf('  Which invoices are overdue?\n Sum by customer. ')).toBe('Which invoices are overdue? Sum by customer.');
    const long = chatTitleOf('Which SKUs at the Oakland warehouse will stock out before their next purchase order arrives from the vendor?');
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith('…')).toBe(true);
    expect(long).toStartWith('Which SKUs at the Oakland warehouse will stock out');
  });

  test('chat ids: only our prefixes', () => {
    expect(isChatId('copilot-0b4c7a52-8d0e-4c1a-9f5e-1a2b3c4d5e6f')).toBe(true);
    expect(isChatId('ops-lead-caed01cd-160f-4dd8-941a-0ef6513cd0bc')).toBe(true);
    expect(isChatId('someone-elses-thread')).toBe(false);
  });
});

describe('run labels', () => {
  const run = { runId: 'a1b2c3d4-0000', workflowId: 'restock' };
  test('place from the proposal title, else vendor count, else id', () => {
    expect(runLabel({ ...run, proposal: { title: 'Restock 5 vendors · Oakland Warehouse' } as never })).toBe('Restock · Oakland Warehouse');
    expect(runLabel({ ...run, proposal: { title: 'Restock 4 vendors' } as never })).toBe('Restock · 4 vendors');
    expect(runLabel({ ...run, proposal: null })).toBe('Restock · a1b2c3d4');
  });
});

const step = (id: string, name: string, kind: AgentStep['kind'] = 'tool'): StepRow => ({
  kind: 'step',
  retries: [],
  step: { type: 'step', id, kind, verb: 'Called', object: { name }, detail: null, status: 'done', startedAt: '', finishedAt: '', error: null, retryOf: null, note: null, tokens: null, costUsd: null, calls: [] },
});

describe('folding repeated tool calls', () => {
  test('back-to-back calls of one tool fold; others stay', () => {
    const rows = foldRepeatedTools([step('1', 'distru.velocity_report'), step('2', 'distru.velocity_report'), step('3', 'distru.velocity_report'), step('4', 'distru.vendors'), step('5', 'distru.velocity_report')]);
    expect(rows.map((row) => (row.kind === 'group' ? `group×${row.steps.length}` : row.kind === 'step' ? row.step.id : 'note'))).toEqual(['group×3', '4', '5']);
  });

  test('per-call arguments read apart', () => {
    expect(argsSummary({ location_id: '3f2a9c1e-1111-2222-3333-444455556666', lead_time_days: 14, below_reorder_point: true })).toBe(
      'location_id: 3f2a9c1e · lead_time_days: 14 · below_reorder_point: true',
    );
    expect(argsSummary({})).toBeNull();
  });
});

describe('errors', () => {
  test('stream error chunk → code + raw detail; unknown code → agent_error', () => {
    expect(copilotErrorOfChunk({ code: 'model_history_invalid', error: { name: 'AI_APICallError', message: 'Invalid `signature`' } })).toEqual({
      code: 'model_history_invalid',
      detail: 'AI_APICallError: Invalid `signature`',
    });
    expect(copilotErrorOfChunk({ code: 'weird', error: 'x' }).code).toBe('agent_error');
  });

  test('thrown: HTTP status or network', () => {
    expect(copilotErrorOfThrown(new Error('HTTP error! status: 429 - slow down')).code).toBe('rate_limited');
    expect(copilotErrorOfThrown(new Error('HTTP error! status: 503')).code).toBe('model_unavailable');
    expect(copilotErrorOfThrown(new TypeError('Failed to fetch')).code).toBe('network');
  });

  test('a stored failed turn reads as failed, in our words', () => {
    const turns = turnsOfHistory([
      { id: 'u1', role: 'user', content: { parts: [{ type: 'text', text: 'Which invoices are overdue?' }] } },
      { id: 'a1', role: 'assistant', content: { parts: [{ type: 'error', error: { name: 'AI_APICallError', message: 'boom' } }] } },
    ]);
    expect(turns[0]?.status).toBe('failed');
    expect(turns[0]?.error).toEqual({ code: 'agent_error', detail: 'AI_APICallError: boom' });
  });
});
