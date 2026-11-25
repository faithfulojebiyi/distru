import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { parseAgentOutput } from '../src/mastra/workflows/agent-call';

const Schema = z.object({
  lines: z.array(z.object({ sku: z.string(), quantity: z.number().int(), reason: z.string().max(40) })),
  note: z.string().max(20).optional(),
});

describe('parseAgentOutput', () => {
  test('valid output passes through unchanged', () => {
    const value = { lines: [{ sku: 'A', quantity: 3, reason: 'short' }] };
    expect(parseAgentOutput(Schema, value)).toEqual(value);
  });

  test('an overlong string is shortened to fit, everywhere it occurs', () => {
    const long = 'x'.repeat(100);
    const out = parseAgentOutput(Schema, { lines: [{ sku: 'A', quantity: 3, reason: long }, { sku: 'B', quantity: 1, reason: 'ok' }], note: long });
    expect(out.lines[0]!.reason.length).toBe(40);
    expect(out.lines[0]!.reason.endsWith('…')).toBe(true);
    expect(out.lines[1]!.reason).toBe('ok');
    expect(out.note!.length).toBe(20);
  });

  test('the input object is not mutated', () => {
    const value = { lines: [{ sku: 'A', quantity: 3, reason: 'y'.repeat(60) }] };
    parseAgentOutput(Schema, value);
    expect(value.lines[0]!.reason.length).toBe(60);
  });

  test('anything else that does not match still throws', () => {
    expect(() => parseAgentOutput(Schema, { lines: [{ sku: 'A', quantity: 2.5, reason: 'r' }] })).toThrow();
    expect(() => parseAgentOutput(Schema, { lines: [{ sku: 'A', reason: 'z'.repeat(60) }] })).toThrow();
  });
});
