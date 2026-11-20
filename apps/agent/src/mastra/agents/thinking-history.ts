import type { MastraDBMessage } from '@mastra/core/agent';
import type { ProcessAPIErrorArgs, ProcessAPIErrorResult, Processor, ProcessLLMRequestArgs, ProcessLLMRequestResult } from '@mastra/core/processors';

/**
 * Keeps signed Anthropic thinking blocks from earlier conversations out of the model request.
 *
 * Claude (Sonnet 5.5 here) binds each `thinking` block's signature to the exact prefix that produced it:
 * the system prompt, the tool list and every earlier message. Mastra Memory replays stored assistant turns
 * with their reasoning parts, and the supervisor forwards the Ops Lead's conversation to subagents, so a
 * replayed block is rejected as soon as that prefix differs from when it was created:
 *
 *   messages.5.content.0: Invalid `signature` in `thinking` block. The block is bound to a different
 *   conversation. ... The `system` prompt and the `tools` list both differ from when this block was created.
 *
 * That happens after every deploy that touches instructions or tools, when `lastMessages` slides its window,
 * when semantic recall changes what is in context, and for every delegation (the subagent has a different
 * system prompt and tools). So:
 *
 * - Preemptive (`processLLMRequest`): reasoning parts that were not produced in this run (stored history,
 *   forwarded parent context) are dropped from the outbound prompt. Text, tool calls and tool results stay.
 *   Reasoning from this run's own steps is kept, so the tool loop of the current turn still round-trips its
 *   thinking and the prompt cache keeps working within the turn. Removing the older blocks is a leading run
 *   of thinking blocks, which the API accepts; persisted history (memory, UI) is untouched.
 * - Reactive (`processAPIError`, defence in depth): if Anthropic still rejects a signature, strip reasoning
 *   from the in-flight message list (history first, everything if that was not enough), log a warning and
 *   retry the step once, so the operator never sees the failure.
 *
 * `sendReasoning: false` on the Anthropic provider is not an alternative: it drops every reasoning part,
 * including the current turn's, which the tool loop needs.
 */
export const THINKING_HISTORY_GUARD_ID = 'thinking-history-guard';

/** Anthropic's rejection of a replayed thinking block (conversation-bound or tampered signature). */
export const INVALID_THINKING_SIGNATURE = /invalid `?signature`? in `?thinking`? block|bound to a different conversation/i;

type Prompt = ProcessLLMRequestArgs['prompt'];
type PromptMessage = Prompt[number];

export interface ThinkingHistoryGuardOptions {
  /** Where the reactive recovery is reported (default: console.warn). */
  warn?: (message: string, details: Record<string, unknown>) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** The signature (or redacted payload) that identifies a signed Anthropic reasoning block. */
function signatureOf(meta: unknown): string | null {
  if (!isRecord(meta) || !isRecord(meta.anthropic)) return null;
  const { signature, redactedData } = meta.anthropic;
  if (typeof signature === 'string' && signature) return signature;
  if (typeof redactedData === 'string' && redactedData) return redactedData;
  return null;
}

/** Signatures of the reasoning this run produced itself (the current turn's steps). */
function ownSignatures(messages: readonly MastraDBMessage[]): Set<string> {
  const own = new Set<string>();
  for (const message of messages) {
    for (const part of message.content?.parts ?? []) {
      if (part.type !== 'reasoning') continue;
      const signature = signatureOf(part.providerMetadata);
      if (signature) own.add(signature);
    }
  }
  return own;
}

/** Drops reasoning parts the predicate selects; assistant turns left empty are removed. */
function dropReasoning(prompt: Prompt, drop: (part: { providerOptions?: unknown }, index: number) => boolean): Prompt | undefined {
  let changed = false;
  const next: PromptMessage[] = [];
  prompt.forEach((message, index) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      next.push(message);
      return;
    }
    const kept = message.content.filter((part) => !(part.type === 'reasoning' && drop(part, index)));
    if (kept.length === message.content.length) {
      next.push(message);
      return;
    }
    changed = true;
    if (kept.length > 0) next.push({ ...message, content: kept });
  });
  return changed ? next : undefined;
}

/** Outbound prompt without signed reasoning that this run did not produce. */
export function stripForeignThinking(prompt: Prompt, ownResponse: readonly MastraDBMessage[] | null): Prompt | undefined {
  if (ownResponse) {
    const own = ownSignatures(ownResponse);
    return dropReasoning(prompt, (part) => {
      const signature = signatureOf(part.providerOptions);
      return signature !== null && !own.has(signature);
    });
  }
  // No message list: everything before the latest user message is history.
  const lastUser = prompt.findLastIndex((message) => message.role === 'user');
  return dropReasoning(prompt, (_part, index) => index < lastUser);
}

/** Removes reasoning parts from the given stored messages, in place. Returns how many were removed. */
function stripReasoningParts(messages: readonly MastraDBMessage[]): number {
  let removed = 0;
  for (const message of messages) {
    const parts = message.content?.parts;
    if (message.role !== 'assistant' || !parts?.length) continue;
    const kept = parts.filter((part) => part.type !== 'reasoning');
    if (kept.length === parts.length) continue;
    removed += parts.length - kept.length;
    parts.splice(0, parts.length, ...kept);
  }
  return removed;
}

function errorText(error: unknown): string {
  const texts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && isRecord(current); depth++) {
    for (const key of ['message', 'responseBody']) if (typeof current[key] === 'string') texts.push(current[key]);
    current = current.cause;
  }
  if (typeof error === 'string') texts.push(error);
  return texts.join('\n');
}

export class ThinkingHistoryGuard implements Processor<typeof THINKING_HISTORY_GUARD_ID> {
  readonly id = THINKING_HISTORY_GUARD_ID;
  readonly name = 'Thinking History Guard';
  readonly #warn: NonNullable<ThinkingHistoryGuardOptions['warn']>;

  constructor(options: ThinkingHistoryGuardOptions = {}) {
    this.#warn = options.warn ?? ((message, details) => console.warn(`[${THINKING_HISTORY_GUARD_ID}] ${message}`, details));
  }

  processLLMRequest({ prompt, messageList }: ProcessLLMRequestArgs): ProcessLLMRequestResult {
    const next = stripForeignThinking(prompt, messageList ? messageList.get.response.db() : null);
    return next ? { prompt: next } : undefined;
  }

  processAPIError({ error, messageList, retryCount, state, agent }: ProcessAPIErrorArgs): ProcessAPIErrorResult | void {
    if (retryCount > 1 || state.recovered === true) return;
    const text = errorText(error);
    if (!INVALID_THINKING_SIGNATURE.test(text)) return;
    const response = new Set(messageList.get.response.db());
    const history = messageList.get.all.db().filter((message) => !response.has(message));
    let removed = stripReasoningParts(history);
    let scope = 'history';
    if (removed === 0) {
      removed = stripReasoningParts(messageList.get.all.db());
      scope = 'all';
    }
    if (removed === 0) return;
    state.recovered = true;
    this.#warn('Anthropic rejected a replayed thinking block; retrying the step without reasoning history', {
      agent: agent?.id ?? null,
      removed,
      scope,
      error: text.slice(0, 300),
    });
    return { retry: true };
  }
}
