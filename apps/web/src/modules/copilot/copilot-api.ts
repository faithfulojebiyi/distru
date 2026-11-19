import { useCallback, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { getQueryScope } from '../../lib/query';
import { OPS_LEAD_AGENT_ID, mastraClient } from '../../lib/mastra-client';
import { runKeys } from '../runs/runs-api';
import {
  newTurn,
  subagentOutput,
  textArrived,
  toolCalled,
  toolFinished,
  turnEnded,
  turnsOfHistory,
  type CopilotTurn,
} from './copilot-data';

/** Every Copilot query key, built here so invalidation always matches by prefix. */
export const copilotKeys = {
  thread: (scope: string, threadId: string) => ['copilot', scope, 'thread', threadId] as const,
};

/** One memory thread per user, as the Ops Lead documents: resource = user id, thread = ops-lead-<user id>. */
export const copilotThreadId = (userId: string) => `ops-lead-${userId}`;

/** The thread's stored messages as turns; a thread that does not exist yet is an empty one. */
export const useCopilotHistory = (userId: string | undefined) => {
  const client = useQueryClient();
  const threadId = userId ? copilotThreadId(userId) : '';
  return useQuery({
    queryKey: copilotKeys.thread(getQueryScope(client), threadId),
    enabled: Boolean(userId),
    staleTime: Number.POSITIVE_INFINITY,
    meta: { suppressErrorToast: true },
    retry: false,
    queryFn: async () => {
      try {
        const page = await mastraClient.listThreadMessages(threadId, {
          agentId: OPS_LEAD_AGENT_ID,
          perPage: 100,
        });
        return turnsOfHistory(page.messages);
      } catch (error) {
        // A brand-new user has no thread until their first question.
        if (error instanceof Error && /404|not found/i.test(error.message)) return [];
        throw error;
      }
    },
  });
};

const ChunkSchema = z.object({ type: z.string(), payload: z.unknown().optional() });
const ToolCallSchema = z.object({ toolCallId: z.string(), toolName: z.string(), args: z.unknown().optional() });
const ToolResultSchema = z.object({
  toolCallId: z.string(),
  result: z.unknown().optional(),
  isError: z.boolean().optional(),
});
const ToolErrorSchema = z.object({ toolCallId: z.string(), error: z.unknown().optional() });
const ToolOutputSchema = z.object({ toolCallId: z.string(), output: z.unknown() });
const TextSchema = z.object({ text: z.string() });
const ErrorSchema = z.object({ error: z.unknown() });

const messageOfError = (error: unknown) => {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return 'The Copilot could not answer. Try again.';
};

/**
 * Asks the Ops Lead through Mastra's built-in agent stream (POST /api/agents/ops-lead/stream) and folds each
 * chunk into the live turn: tool calls become step rows and cards, subagent output joins its hand-off, text
 * streams into the answer. The session cookie authenticates; the server maps the resource to the user.
 */
export const useCopilotStream = (userId: string | undefined) => {
  const client = useQueryClient();
  const [live, setLive] = useState<CopilotTurn | null>(null);
  const abort = useRef<AbortController | null>(null);

  // The live turn mirrored in a ref, so chunk handlers and finish read the newest one synchronously.
  const current = useRef<CopilotTurn | null>(null);
  const put = useCallback((turn: CopilotTurn | null) => {
    current.current = turn;
    setLive(turn);
  }, []);

  const apply = useCallback(
    (change: (turn: CopilotTurn) => CopilotTurn) => {
      if (current.current) put(change(current.current));
    },
    [put],
  );

  const finish = useCallback(
    (status: CopilotTurn['status'], error: string | null = null) => {
      if (!current.current || !userId) return;
      const done = turnEnded(current.current, status, new Date().toISOString(), error);
      // Move the finished turn into the history cache, so the live slot frees up for the next question.
      const key = copilotKeys.thread(getQueryScope(client), copilotThreadId(userId));
      client.setQueryData<CopilotTurn[]>(key, (turns) => [...(turns ?? []), done]);
      put(null);
      if (done.links.some((link) => link.kind === 'run'))
        void client.invalidateQueries({ queryKey: runKeys.all(getQueryScope(client)) });
    },
    [client, put, userId],
  );

  const ask = useCallback(
    async (question: string) => {
      if (!userId || abort.current) return;
      const controller = new AbortController();
      abort.current = controller;
      put(newTurn(crypto.randomUUID(), question));
      let failed: string | null = null;
      try {
        const response = await mastraClient.getAgent(OPS_LEAD_AGENT_ID).stream(question, {
          memory: { thread: copilotThreadId(userId), resource: userId },
          abortSignal: controller.signal,
        });
        await response.processDataStream({
          onChunk: async (raw) => {
            const chunk = ChunkSchema.safeParse(raw);
            if (!chunk.success) return;
            const at = new Date().toISOString();
            const { type, payload } = chunk.data;
            if (type === 'text-delta') {
              const text = TextSchema.safeParse(payload);
              if (text.success) apply((turn) => textArrived(turn, text.data.text, at));
            } else if (type === 'tool-call') {
              const call = ToolCallSchema.safeParse(payload);
              if (call.success)
                apply((turn) => toolCalled(turn, { ...call.data, args: call.data.args ?? {} }, at));
            } else if (type === 'tool-result') {
              const done = ToolResultSchema.safeParse(payload);
              if (done.success)
                apply((turn) =>
                  toolFinished(turn, { toolCallId: done.data.toolCallId, result: done.data.result, isError: Boolean(done.data.isError) }, at),
                );
            } else if (type === 'tool-error') {
              const done = ToolErrorSchema.safeParse(payload);
              if (done.success)
                apply((turn) =>
                  toolFinished(turn, { toolCallId: done.data.toolCallId, result: messageOfError(done.data.error), isError: true }, at),
                );
            } else if (type === 'tool-output') {
              const output = ToolOutputSchema.safeParse(payload);
              if (output.success)
                apply((turn) => subagentOutput(turn, output.data.toolCallId, output.data.output));
            } else if (type === 'error') {
              const error = ErrorSchema.safeParse(payload);
              failed = messageOfError(error.success ? error.data.error : payload);
            }
          },
        });
        finish(failed ? 'failed' : 'done', failed);
      } catch (error) {
        if (controller.signal.aborted) finish('stopped');
        else finish('failed', messageOfError(error));
      } finally {
        abort.current = null;
      }
    },
    [apply, finish, put, userId],
  );

  const stop = useCallback(() => abort.current?.abort(), []);

  return { live, ask, stop, streaming: live?.status === 'streaming' };
};
