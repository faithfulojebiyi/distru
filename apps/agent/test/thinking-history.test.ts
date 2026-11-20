/**
 * Replayed thinking blocks: Claude binds a thinking block's signature to the system prompt, tools and messages
 * that produced it, so a Copilot thread whose stored turns carry thinking fails once the Ops Lead's prompt or
 * tools change ("Invalid `signature` in `thinking` block. The block is bound to a different conversation").
 * A scripted model plays Anthropic: it rejects any request that replays a stored (foreign) signature.
 */
import { describe, expect, test } from 'bun:test';
import { Agent } from '@mastra/core/agent';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { z } from 'zod';
import { createOpsLead } from '../src/mastra/agents/ops-lead';
import { ThinkingHistoryGuard } from '../src/mastra/agents/thinking-history';

const USER = 'user-1';
const THREAD = `ops-lead-${USER}`;
const OLD_SIGNATURE = 'sig-from-an-older-system-prompt';
const OWN_SIGNATURE = 'sig-from-this-turn';
const SIGNATURE_ERROR =
  'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". The `system` prompt and the `tools` list both differ from when this block was created.';

type Call = { prompt: unknown };
type StreamPart = Record<string, unknown>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every reasoning part in the outbound prompt, with its Anthropic signature. */
function reasoningIn(prompt: unknown): Array<{ text: unknown; signature: unknown }> {
  const found: Array<{ text: unknown; signature: unknown }> = [];
  for (const message of Array.isArray(prompt) ? prompt.filter(isRecord) : []) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content.filter(isRecord)) {
      if (part.type !== 'reasoning') continue;
      const anthropic = isRecord(part.providerOptions) && isRecord(part.providerOptions.anthropic) ? part.providerOptions.anthropic : {};
      found.push({ text: part.text, signature: anthropic.signature });
    }
  }
  return found;
}

function textIn(prompt: unknown): string {
  return JSON.stringify(prompt);
}

function apiError(message: string) {
  return Object.assign(new Error(message), { name: 'AI_APICallError', statusCode: 400, isRetryable: false, responseBody: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }) });
}

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

function stream(parts: StreamPart[]) {
  return {
    stream: new ReadableStream({
      start(controller) {
        for (const part of [{ type: 'stream-start', warnings: [] }, ...parts]) controller.enqueue(part);
        controller.close();
      },
    }),
  };
}

const thinking = (id: string, text: string, signature: string): StreamPart[] => [
  { type: 'reasoning-start', id },
  { type: 'reasoning-delta', id, delta: text },
  { type: 'reasoning-delta', id, delta: '', providerMetadata: { anthropic: { signature } } },
  { type: 'reasoning-end', id, providerMetadata: { anthropic: { signature } } },
];

const answer = (text: string): StreamPart[] => [
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: text },
  { type: 'text-end', id: 't' },
  { type: 'finish', finishReason: 'stop', usage },
];

/**
 * Anthropic, scripted: rejects a replayed foreign signature; otherwise thinks + calls a tool, then answers.
 * `rejectFirst` makes the first call fail whatever the prompt (to exercise the reactive recovery).
 */
function claude(opts: { rejectFirst?: boolean } = {}) {
  const calls: Call[] = [];
  const model = new MastraLanguageModelV2Mock({
    provider: 'anthropic.messages',
    modelId: 'claude-sonnet-5-5',
    doStream: async (options) => {
      calls.push({ prompt: options.prompt });
      if (opts.rejectFirst && calls.length === 1) throw apiError(SIGNATURE_ERROR);
      if (reasoningIn(options.prompt).some((r) => r.signature === OLD_SIGNATURE)) throw apiError(SIGNATURE_ERROR);
      const toolResults = textIn(options.prompt).includes('"tool-result"') && textIn(options.prompt).includes('Harbor Greens');
      if (!toolResults) {
        return stream([
          ...thinking('r1', 'I should look up overdue invoices.', OWN_SIGNATURE),
          { type: 'tool-call', toolCallId: 'call_1', toolName: 'distru_invoices_overdue', input: '{}' },
          { type: 'finish', finishReason: 'tool-calls', usage },
        ]);
      }
      return stream(answer('Harbor Greens owes $12,400, 45 days overdue.'));
    },
  });
  return { model, calls };
}

const overdue = createTool({
  id: 'distru_invoices_overdue',
  description: 'Overdue invoices by customer',
  inputSchema: z.object({}),
  execute: async () => ({ customers: [{ customer: 'Harbor Greens', overdue: 12_400, days: 45 }] }),
});

/** A thread as it was stored before the deploy: the assistant turn carries a signed thinking block. */
async function memoryWithOldThread() {
  const memory = new Memory({ storage: new InMemoryStore(), options: { lastMessages: 20 } });
  await memory.createThread({ threadId: THREAD, resourceId: USER, title: 'Copilot' });
  const at = Date.now() - 60_000;
  await memory.saveMessages({
    messages: [
      { id: 'm1', threadId: THREAD, resourceId: USER, role: 'user', createdAt: new Date(at), content: { format: 2, parts: [{ type: 'text', text: 'Which vendor has the longest lead time?' }] } },
      {
        id: 'm2',
        threadId: THREAD,
        resourceId: USER,
        role: 'assistant',
        createdAt: new Date(at + 1000),
        content: {
          format: 2,
          parts: [
            { type: 'reasoning', reasoning: '', details: [{ type: 'text', text: 'old thoughts' }], providerMetadata: { anthropic: { signature: OLD_SIGNATURE } } },
            { type: 'text', text: 'Golden State Farms: 14 days.' },
          ],
        },
      },
    ],
  });
  return memory;
}

async function askCopilot(agent: Agent) {
  const output = await agent.stream('Which invoices are overdue? Sum by customer.', { memory: { thread: THREAD, resource: USER }, maxSteps: 4 });
  const errors: unknown[] = [];
  for await (const chunk of output.fullStream) if (chunk.type === 'error') errors.push(chunk.payload);
  return { text: await output.text, errors };
}

describe('thinking blocks in replayed history', () => {
  test('without the guard, a stored thinking block breaks the next Copilot turn (reproduction)', async () => {
    const { model } = claude();
    const memory = await memoryWithOldThread();
    const agent = new Agent({ id: 'ops-lead', name: 'Ops Lead', instructions: 'v2 prompt', model, tools: { distru_invoices_overdue: overdue }, memory });
    const { text, errors } = await askCopilot(agent);
    expect(text).not.toContain('Harbor Greens');
    expect(JSON.stringify(errors)).toContain('bound to a different conversation');
  });

  test("Ops Lead: history replays without its thinking; this turn's thinking still round-trips", async () => {
    const { model, calls } = claude();
    const memory = await memoryWithOldThread();
    const opsLead = createOpsLead({ model, tools: { distru_invoices_overdue: overdue }, agents: {}, memory });
    const { text, errors } = await askCopilot(opsLead);

    expect(errors).toEqual([]);
    expect(text).toContain('Harbor Greens');
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      // The stored turn's visible text is still in context; its signed thinking is not.
      expect(textIn(call.prompt)).toContain('Golden State Farms: 14 days.');
      expect(reasoningIn(call.prompt).map((r) => r.signature)).not.toContain(OLD_SIGNATURE);
    }
    // Step 2 replays step 1's thinking (same turn, same prefix) together with its tool call.
    expect(reasoningIn(calls[1]?.prompt)).toEqual([{ text: 'I should look up overdue invoices.', signature: OWN_SIGNATURE }]);

    // Persisted history keeps the reasoning (UI, audit); only the outbound request is trimmed.
    const { messages } = await memory.recall({ threadId: THREAD, resourceId: USER });
    expect(JSON.stringify(messages)).toContain(OLD_SIGNATURE);
  });

  test('reactive: an unexpected signature rejection is retried once without reasoning and logged', async () => {
    const { model, calls } = claude({ rejectFirst: true });
    const memory = await memoryWithOldThread();
    const warnings: Array<{ message: string; details: Record<string, unknown> }> = [];
    const agent = new Agent({
      id: 'ops-lead',
      name: 'Ops Lead',
      instructions: 'v2 prompt',
      model,
      tools: { distru_invoices_overdue: overdue },
      memory,
      errorProcessors: [new ThinkingHistoryGuard({ warn: (message, details) => warnings.push({ message, details }) })],
    });
    const { text, errors } = await askCopilot(agent);

    expect(errors).toEqual([]);
    expect(text).toContain('Harbor Greens');
    expect(calls.length).toBe(3); // rejected, retried step 1, step 2
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.details).toMatchObject({ agent: 'ops-lead' });
  });

  test('every agent carries the guard', async () => {
    const { restockEnv } = await import('./fixtures/restock-env');
    const env = await restockEnv();
    for (const agent of Object.values(env.agents)) {
      const ids = (await agent.listErrorProcessors()).map((p) => p.id);
      // Ours, plus Mastra's defaults (ProviderHistoryCompat & co.) still merged in.
      expect(ids).toContain('thinking-history-guard');
      expect(ids).toContain('provider-history-compat');
    }
  });
});
