// Chats: adapted from carbonme modules/chats/chat-api.ts (useChats, useCreateChat, useUpdateChat, useDeleteChat),
// backed by Mastra Memory threads of the Ops Lead through @mastra/client-js. The server maps the session user to the
// memory resource, so lists, reads, renames and deletes only ever reach the caller's own threads.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { getCopilotCapabilities } from '../../api/generated/copilot/copilot';
import { getQueryScope } from '../../lib/query';
import { OPS_LEAD_AGENT_ID, mastraClient } from '../../lib/mastra-client';
import { toast } from '@ops/ui/primitives/toast/toast';
import { runKeys } from '../runs/runs-api';
import {
  CopilotChatSchema,
  chatTitleOf,
  sortChats,
  type CopilotChat,
} from './copilot-chats-data';
import {
  copilotErrorOfChunk,
  copilotErrorOfThrown,
  newTurn,
  subagentOutput,
  textArrived,
  toolCalled,
  toolFinished,
  turnEnded,
  turnsOfHistory,
  type CopilotError,
  type CopilotTurn,
} from './copilot-data';

/** Every Copilot query key, built here so invalidation always matches by prefix. */
export const copilotKeys = {
  all: (scope: string) => ['copilot', scope] as const,
  chats: (scope: string) => ['copilot', scope, 'chats'] as const,
  thread: (scope: string, threadId: string) => ['copilot', scope, 'thread', threadId] as const,
};

/** What the Ops Lead can answer right now (topics backed by its current tools), for the new-chat page. */
export const useCopilotCapabilities = () => {
  const client = useQueryClient();
  return useQuery({
    queryKey: [...copilotKeys.all(getQueryScope(client)), 'capabilities'] as const,
    queryFn: ({ signal }) => getCopilotCapabilities({ signal }),
    staleTime: 5 * 60_000,
    meta: { suppressErrorToast: true },
  });
};

const isNotFound =(error: unknown) => error instanceof Error && /\b404\b|not found/i.test(error.message);

/** The caller's chats, latest activity first. */
export const useCopilotChats = (userId: string | undefined) => {
  const client = useQueryClient();
  return useQuery({
    queryKey: copilotKeys.chats(getQueryScope(client)),
    enabled: Boolean(userId),
    meta: { suppressErrorToast: true },
    queryFn: async (): Promise<CopilotChat[]> => {
      const page = await mastraClient.listMemoryThreads({
        resourceId: userId,
        agentId: OPS_LEAD_AGENT_ID,
        perPage: 100,
        orderBy: { field: 'updatedAt', direction: 'DESC' },
      });
      return sortChats(page.threads.flatMap((thread) => {
        const chat = CopilotChatSchema.safeParse(thread);
        return chat.success ? [chat.data] : [];
      }));
    },
  });
};

const updateTitle = (threadId: string, title: string) =>
  mastraClient.getMemoryThread({ threadId, agentId: OPS_LEAD_AGENT_ID }).update({ title });

/**
 * Chats from before titles existed (the Ops Lead's original `ops-lead-<user>` thread) get one from their first
 * question, once, so the list never shows "Untitled chat" for them.
 */
export const useBackfillChatTitles = (chats: readonly CopilotChat[] | undefined) => {
  const client = useQueryClient();
  const tried = useRef(new Set<string>());
  useEffect(() => {
    const untitled = (chats ?? []).filter((chat) => !chat.title?.trim() && !tried.current.has(chat.id));
    if (!untitled.length) return;
    for (const chat of untitled) tried.current.add(chat.id);
    void Promise.all(
      untitled.map(async (chat) => {
        const page = await mastraClient.listThreadMessages(chat.id, { agentId: OPS_LEAD_AGENT_ID, perPage: 20 });
        const first = turnsOfHistory(page.messages).find((turn) => turn.question.trim());
        if (first) await updateTitle(chat.id, chatTitleOf(first.question));
      }),
    )
      .catch(() => undefined)
      .finally(() => void client.invalidateQueries({ queryKey: copilotKeys.chats(getQueryScope(client)) }));
  }, [chats, client]);
};

/** Opens a chat (a thread titled from its first question) before that question streams into it. */
export const useCreateChat = (userId: string | undefined) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ threadId, question }: { threadId: string; question: string }) => {
      if (!userId) throw new Error('Not signed in');
      await mastraClient.createMemoryThread({
        agentId: OPS_LEAD_AGENT_ID,
        resourceId: userId,
        threadId,
        title: chatTitleOf(question),
        metadata: { kind: 'copilot' },
      });
    },
    onSuccess: () => void client.invalidateQueries({ queryKey: copilotKeys.chats(getQueryScope(client)) }),
  });
};

export const useRenameChat = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ threadId, title }: { threadId: string; title: string }) => updateTitle(threadId, title.trim()),
    onSuccess: () => void client.invalidateQueries({ queryKey: copilotKeys.chats(getQueryScope(client)) }),
    onError: () => toast.error('Could not rename the chat.'),
  });
};

export const useDeleteChat = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (threadId: string) =>
      mastraClient.getMemoryThread({ threadId, agentId: OPS_LEAD_AGENT_ID }).delete({ agentId: OPS_LEAD_AGENT_ID }),
    onSuccess: (_result, threadId) => {
      const scope = getQueryScope(client);
      client.removeQueries({ queryKey: copilotKeys.thread(scope, threadId) });
      void client.invalidateQueries({ queryKey: copilotKeys.chats(scope) });
    },
  });
};

/** The thread's stored messages as turns; a thread that does not exist yet is an empty one. */
export const useCopilotHistory = (threadId: string | null) => {
  const client = useQueryClient();
  return useQuery({
    queryKey: copilotKeys.thread(getQueryScope(client), threadId ?? ''),
    enabled: Boolean(threadId),
    staleTime: Number.POSITIVE_INFINITY,
    meta: { suppressErrorToast: true },
    retry: false,
    queryFn: async () => {
      if (!threadId) return [];
      try {
        const page = await mastraClient.listThreadMessages(threadId, {
          agentId: OPS_LEAD_AGENT_ID,
          perPage: 100,
        });
        return turnsOfHistory(page.messages);
      } catch (error) {
        // A chat has no stored messages until its first question is answered.
        if (isNotFound(error)) return [];
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

const messageOfError = (error: unknown) => {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return 'The tool call failed.';
};

/**
 * Asks the Ops Lead through Mastra's built-in agent stream (POST /api/agents/ops-lead/stream) and folds each
 * chunk into the live turn: tool calls become step rows and cards, subagent output joins its hand-off, text
 * streams into the answer. The session cookie authenticates; the server maps the resource to the user.
 */
export const useCopilotStream = (userId: string | undefined, threadId: string | null) => {
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
    (status: CopilotTurn['status'], error: CopilotError | null = null) => {
      if (!current.current || !threadId) return;
      const done = turnEnded(current.current, status, new Date().toISOString(), error);
      // Move the finished turn into the history cache, so the live slot frees up for the next question.
      const scope = getQueryScope(client);
      client.setQueryData<CopilotTurn[]>(copilotKeys.thread(scope, threadId), (turns) => [...(turns ?? []), done]);
      // The chat moved to the top of the list.
      void client.invalidateQueries({ queryKey: copilotKeys.chats(scope) });
      put(null);
      if (done.links.some((link) => link.kind === 'run'))
        void client.invalidateQueries({ queryKey: runKeys.all(getQueryScope(client)) });
    },
    [client, put, threadId],
  );

  const ask = useCallback(
    async (question: string) => {
      if (!userId || !threadId || abort.current) return;
      const controller = new AbortController();
      abort.current = controller;
      put(newTurn(crypto.randomUUID(), question));
      let failed: CopilotError | null = null;
      try {
        const response = await mastraClient.getAgent(OPS_LEAD_AGENT_ID).stream(question, {
          memory: { thread: threadId, resource: userId },
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
              // The server adds a stable `code`; the raw provider error is only logged and kept for "Details".
              failed = copilotErrorOfChunk(payload);
              console.error('[copilot] the Ops Lead stream failed', failed.code, payload);
            }
          },
        });
        finish(failed ? 'failed' : 'done', failed);
      } catch (error) {
        if (controller.signal.aborted) finish('stopped');
        else {
          console.error('[copilot] the Ops Lead request failed', error);
          finish('failed', copilotErrorOfThrown(error));
        }
      } finally {
        abort.current = null;
      }
    },
    [apply, finish, put, userId, threadId],
  );

  const stop = useCallback(() => abort.current?.abort(), []);

  return { live, ask, stop, streaming: live?.status === 'streaming' };
};
