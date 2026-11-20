/**
 * Agent stream errors carry a stable code: Mastra's real stream route, a model that fails like Anthropic,
 * and the middleware the app installs. Clients map the code; the raw provider error stays in `payload.error`.
 */
import { describe, expect, test } from 'bun:test';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { MastraServer } from '@mastra/hono';
import { Hono } from 'hono';
import { agentStreamErrorCodes, classifyAgentError, type AgentErrorCode } from '../src/api/agent-errors';

const SIGNATURE =
  'messages.5.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block".';

const apiError = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { name: 'AI_APICallError', statusCode, isRetryable: statusCode >= 500 || statusCode === 429 });

describe('classifyAgentError', () => {
  const cases: Array<[unknown, AgentErrorCode]> = [
    [apiError(SIGNATURE, 400), 'model_history_invalid'],
    [{ name: 'AI_APICallError', message: SIGNATURE }, 'model_history_invalid'],
    [apiError('messages.3: `tool_use` ids were found without `tool_result` blocks immediately after', 400), 'model_history_invalid'],
    [apiError('Number of request tokens has exceeded your per-minute rate limit', 429), 'rate_limited'],
    [apiError('Overloaded', 529), 'model_unavailable'],
    [apiError('Internal server error', 500), 'model_unavailable'],
    [apiError('invalid x-api-key', 401), 'model_unavailable'],
    [new TypeError('fetch failed'), 'model_unavailable'],
    [apiError('prompt is too long: 1050000 tokens > 1000000 maximum', 400), 'context_too_long'],
    [apiError('something else', 400), 'agent_error'],
    ['boom', 'agent_error'],
  ];
  for (const [error, code] of cases) test(`${code}: ${error instanceof Error ? error.message.slice(0, 40) : JSON.stringify(error).slice(0, 40)}`, () => expect(classifyAgentError(error)).toBe(code));
});

describe('agent stream route', () => {
  async function appWithFailingAgent(message: string, status: number) {
    const model = new MastraLanguageModelV2Mock({
      provider: 'anthropic.messages',
      modelId: 'claude-sonnet-5-5',
      doStream: async () => {
        throw apiError(message, status);
      },
    });
    const agent = new Agent({ id: 'ops-lead', name: 'Ops Lead', instructions: 'x', model, errorProcessorDefaults: false });
    const mastra = new Mastra({ agents: { opsLead: agent }, logger: false });
    const app = new Hono();
    const logged: AgentErrorCode[] = [];
    app.use('/api/agents/:agentId/stream', agentStreamErrorCodes((code) => logged.push(code)));
    await new MastraServer({ app, mastra }).init();
    return { app, logged };
  }

  async function errorChunks(res: Response) {
    const text = await res.text();
    return text
      .split('\n\n')
      .filter((event) => event.startsWith('data: '))
      .flatMap((event) => {
        try {
          return [JSON.parse(event.slice(6)) as { type: string; payload?: Record<string, unknown> }];
        } catch {
          return [];
        }
      })
      .filter((chunk) => chunk.type === 'error');
  }

  test('a rejected history arrives as code model_history_invalid, with the raw error kept as detail', async () => {
    const { app, logged } = await appWithFailingAgent(SIGNATURE, 400);
    const res = await app.request('/api/agents/ops-lead/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Which invoices are overdue?' }] }),
    });
    expect(res.status).toBe(200);
    const errors = await errorChunks(res);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.payload?.code).toBe('model_history_invalid');
    expect(JSON.stringify(errors[0]?.payload?.error)).toContain('bound to a different conversation');
    expect(logged).toEqual(['model_history_invalid']);
  });

  test('a 429 arrives as rate_limited', async () => {
    const { app } = await appWithFailingAgent('rate limit exceeded', 429);
    const res = await app.request('/api/agents/ops-lead/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    const errors = await errorChunks(res);
    expect(errors.map((e) => e.payload?.code)).toEqual(['rate_limited']);
  });
});
