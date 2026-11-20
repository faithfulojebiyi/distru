// Adapted from carbonme modules/chats/chat-api.ts (chatTitle, UNTITLED_CHAT) for Copilot chats, which are Mastra
// Memory threads of the Ops Lead (resource = the signed-in user; the server never lists another user's threads).
import { z } from 'zod';

import type { RunSummary } from '../../api/generated/opsAgentAPI.schemas';

/** A Copilot chat as the sidebar and header show it. */
export const CopilotChatSchema = z.object({
  id: z.string(),
  title: z.string().nullish(),
  createdAt: z.union([z.string(), z.date()]).transform((value) => new Date(value).toISOString()),
  updatedAt: z.union([z.string(), z.date()]).transform((value) => new Date(value).toISOString()),
});
export type CopilotChat = z.infer<typeof CopilotChatSchema>;

export const UNTITLED_CHAT = 'Untitled chat';
export const CHAT_TITLE_MAX = 60;

export const chatTitle = (title: string | null | undefined) => (title?.trim() ? title.trim() : UNTITLED_CHAT);

/**
 * A chat's title from its first question, in code (no model call): one line, at most 60 characters, cut at a word
 * boundary with an ellipsis. "Which invoices are overdue? Sum by customer." stays as it is.
 */
export const chatTitleOf = (question: string): string => {
  const line = question.replace(/\s+/g, ' ').trim();
  if (line.length <= CHAT_TITLE_MAX) return line;
  const cut = line.slice(0, CHAT_TITLE_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > CHAT_TITLE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.–-]+$/, '')}…`;
};

/** The Ops Lead's original single thread, kept as one chat in the list. */
export const legacyChatId = (userId: string) => `ops-lead-${userId}`;

/** A new chat's thread id. */
export const newChatId = () => `copilot-${crypto.randomUUID()}`;

/** Ids the routes accept: our own prefixes only, so a pasted path can't name an arbitrary thread. */
export const isChatId = (id: string) => /^(copilot|ops-lead)-[\w-]{1,120}$/.test(id);

/** Newest activity first. */
export const sortChats = (chats: readonly CopilotChat[]) =>
  [...chats].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

const WORKFLOW_LABELS: Record<string, string> = { restock: 'Restock', 'vendor-reply': 'Vendor reply' };

/**
 * A run's short sidebar label: "Restock · Oakland Warehouse". The place comes from the proposal title ("Restock 5
 * vendors · Oakland Warehouse"); without one, the vendor count, else the run id.
 */
export const runLabel = (run: Pick<RunSummary, 'runId' | 'workflowId' | 'proposal'>): string => {
  const kind = WORKFLOW_LABELS[run.workflowId] ?? run.workflowId;
  const title = run.proposal?.title ?? '';
  const place = title.includes(' · ') ? title.split(' · ').at(-1) : null;
  if (place) return `${kind} · ${place}`;
  const vendors = /(\d+ vendors?)/.exec(title)?.[1];
  return vendors ? `${kind} · ${vendors}` : `${kind} · ${run.runId.slice(0, 8)}`;
};
