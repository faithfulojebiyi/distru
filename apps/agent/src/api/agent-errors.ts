import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';

/**
 * Stable codes for agent failures, so clients never have to show (or parse) a raw model-provider error.
 * Mastra's built-in agent stream (POST /api/agents/:agentId/stream) reports a failure as an SSE `error`
 * chunk whose payload is the provider's error; `agentStreamErrorCodes` adds `payload.code` to it. The raw
 * error stays in `payload.error` for logs and a collapsed "Details" disclosure.
 */
export const AgentErrorCodeSchema = z
  .enum([
    /** The provider rejected the replayed conversation (e.g. a thinking block bound to an older prompt). */
    'model_history_invalid',
    /** Rate limit or quota (HTTP 429). */
    'rate_limited',
    /** The provider is down, overloaded, unreachable, timed out or not configured (5xx, 529, 401/403, network). */
    'model_unavailable',
    /** The request is larger than the model's context window. */
    'context_too_long',
    /** Anything else. */
    'agent_error',
  ])
  .meta({ id: 'AgentErrorCode' });
export type AgentErrorCode = z.infer<typeof AgentErrorCodeSchema>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Status code and every message-ish string on the error and its causes. */
function facts(error: unknown): { status: number | null; text: string } {
  const texts: string[] = [];
  let status: number | null = null;
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
    if (typeof current === 'string') {
      texts.push(current);
      break;
    }
    if (!isRecord(current)) break;
    for (const key of ['name', 'message', 'responseBody', 'code', 'type']) if (typeof current[key] === 'string') texts.push(current[key]);
    for (const key of ['statusCode', 'status']) if (status === null && typeof current[key] === 'number') status = current[key];
    current = current.cause ?? current.error;
  }
  return { status, text: texts.join('\n') };
}

const HISTORY = /invalid `?signature`? in `?thinking`? block|bound to a different conversation|thinking`? or `?redacted_thinking`? blocks? .*cannot be modified|tool_use` ids were found without `tool_result`|unexpected `tool_use_id`/i;
const TOO_LONG = /prompt is too long|context(?: window| length)|too many tokens|maximum context/i;
const RATE = /rate.?limit|too many requests|quota/i;
const UNAVAILABLE = /overloaded|service unavailable|internal server error|bad gateway|gateway timeout|timed? ?out|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|socket hang up|network|api key|authentication|unauthori[sz]ed|credit balance/i;

/** Maps an agent / model-provider error to its stable code. */
export function classifyAgentError(error: unknown): AgentErrorCode {
  const { status, text } = facts(error);
  if (HISTORY.test(text)) return 'model_history_invalid';
  if (status === 429 || RATE.test(text)) return 'rate_limited';
  if (TOO_LONG.test(text) || status === 413) return 'context_too_long';
  if ((status !== null && (status >= 500 || status === 401 || status === 403)) || UNAVAILABLE.test(text)) return 'model_unavailable';
  return 'agent_error';
}

/** Adds `payload.code` to each SSE `error` chunk; every other event passes through byte for byte. */
export function sseErrorCodes(onError?: (code: AgentErrorCode, error: unknown) => void): TransformStream<string, string> {
  let buffer = '';
  const rewrite = (event: string): string => {
    if (!event.startsWith('data: ') || !event.includes('"error"')) return event;
    try {
      const chunk: unknown = JSON.parse(event.slice('data: '.length));
      if (!isRecord(chunk) || chunk.type !== 'error') return event;
      const payload = isRecord(chunk.payload) ? chunk.payload : { error: chunk.payload };
      const code = classifyAgentError(payload.error ?? payload);
      onError?.(code, payload.error ?? payload);
      return `data: ${JSON.stringify({ ...chunk, payload: { ...payload, code } })}`;
    } catch {
      return event;
    }
  };
  return new TransformStream<string, string>({
    transform(text, controller) {
      buffer += text;
      let end = buffer.indexOf('\n\n');
      while (end !== -1) {
        controller.enqueue(`${rewrite(buffer.slice(0, end))}\n\n`);
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf('\n\n');
      }
    },
    flush(controller) {
      if (buffer) controller.enqueue(rewrite(buffer));
    },
  });
}

/** Hono middleware for Mastra's agent stream routes: error chunks carry a stable `code`. */
export function agentStreamErrorCodes(onError?: (code: AgentErrorCode, error: unknown) => void): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const body = c.res.body;
    if (!body || !(c.res.headers.get('content-type') ?? '').includes('text/event-stream')) return;
    const headers = new Headers(c.res.headers);
    headers.delete('content-length');
    c.res = new Response(body.pipeThrough(new TextDecoderStream()).pipeThrough(sseErrorCodes(onError)).pipeThrough(new TextEncoderStream()), {
      status: c.res.status,
      statusText: c.res.statusText,
      headers,
    });
  };
}
