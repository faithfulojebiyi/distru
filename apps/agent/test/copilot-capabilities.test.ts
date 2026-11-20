/**
 * The Copilot's "What I can help with" comes from the Ops Lead's tool allowlist, so it can't drift: every Ops Lead
 * tool belongs to a topic, every topic names only Ops Lead tools, and topics without an available tool drop out.
 */
import { describe, expect, test } from 'bun:test';
import { COPILOT_TOPICS, OPS_LEAD_TOOL_NAMES, copilotCapabilities } from '../src/mastra/agents/ops-lead-capabilities';

describe('Copilot capabilities', () => {
  test('every Ops Lead tool is covered by a topic, and topics name only Ops Lead tools', () => {
    const covered = new Set(COPILOT_TOPICS.flatMap((topic) => topic.tools));
    expect(OPS_LEAD_TOOL_NAMES.filter((tool) => !covered.has(tool))).toEqual([]);
    expect([...covered].filter((tool) => !OPS_LEAD_TOOL_NAMES.includes(tool))).toEqual([]);
  });

  test('topics without an available tool drop out (recall off); start_restock_run is always there', () => {
    const withoutRecall = OPS_LEAD_TOOL_NAMES.filter((tool) => tool !== 'recall.search' && tool !== 'start_restock_run');
    const ids = copilotCapabilities(withoutRecall).topics.map((topic) => topic.id);
    expect(ids).not.toContain('vendor-history');
    expect(ids).toContain('restock');
    expect(ids).toContain('receivables');
    expect(copilotCapabilities([]).topics.map((topic) => topic.id)).toEqual(['restock']);
  });

  test('every topic has 1-2 example questions and the cannot-do list is present', () => {
    const caps = copilotCapabilities(OPS_LEAD_TOOL_NAMES);
    expect(caps.topics).toHaveLength(COPILOT_TOPICS.length);
    for (const topic of caps.topics) expect(topic.examples.length).toBeGreaterThanOrEqual(1);
    expect(caps.cannotDo.join(' ')).toContain('QuickBooks');
    expect(caps.dataset).toContain('Golden Coast Distribution');
  });
});
