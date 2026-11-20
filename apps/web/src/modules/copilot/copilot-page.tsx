// Adapted from carbonme modules/chats/chat-page.tsx (ChatConversation: messages, the live run, follow-to-bottom; the
// header's ChatActionsMenu) and new-chat-page.tsx (a chat not yet created: the first question opens it).
import { useEffect, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Flex, Box } from '@ops/ui/jsx';
import { Skeleton } from '@ops/ui/primitives/skeleton';

import { useMe } from '../session/session-api';
import { ErrorState } from '../system/components/states';
import { useCopilotChats, useCopilotHistory, useCopilotStream, useCreateChat } from './copilot-api';
import { ChatActionsMenu, useChatActions } from './copilot-chat-actions';
import { chatTitle, chatTitleOf, newChatId } from './copilot-chats-data';
import { SUGGESTED_PROMPTS, type CopilotTurn } from './copilot-data';
import { CopilotCapabilities } from './copilot-capabilities';
import { CopilotComposer } from './copilot-composer';
import { AssistantTurn, Empty, FollowUps, SentQuestion } from './copilot-messages';
import { CopilotShell } from './copilot-shell';
import { RecallSearch } from '../recall/recall-search';

const ChatSkeleton = () => (
  <Flex direction="column" gap="6" aria-hidden>
    <Skeleton h="10" w="60%" ml="auto" rounded="2xl" />
    <Skeleton h="4" w="90%" />
    <Skeleton h="4" w="75%" />
  </Flex>
);

const Turn = ({ turn, retry }: { turn: CopilotTurn; retry: (question: string) => void }) => (
  <>
    <SentQuestion text={turn.question} />
    <AssistantTurn turn={turn} retry={retry} />
  </>
);

const EmptyChat = ({ ask }: { ask: (question: string) => void }) => (
  <Box>
    <Empty
      title="Ask the Ops Lead"
      detail="It hands work to the Inventory Analyst, Procurement Planner, Compliance Reviewer and Policy Critic, and can start a restock run. It never writes to Distru."
    />
    <CopilotCapabilities send={ask} />
    <RecallSearch />
  </Box>
);

/**
 * A chat not yet created (/copilot): the empty state and the composer. The first question opens a chat titled from
 * it, and the chat's page asks it. A question handed over from the Overview composer (?q=) does the same at once.
 */
export const NewCopilotPage = ({ initialQuestion = null }: { initialQuestion?: string | null }) => {
  const me = useMe();
  const navigate = useNavigate();
  const userId = me.data?.id;
  const create = useCreateChat(userId);
  const started = useRef(false);

  const start = (question: string) => {
    if (started.current || !question.trim()) return;
    started.current = true;
    const threadId = newChatId();
    create.mutate(
      { threadId, question },
      {
        onSuccess: () => void navigate({ to: '/copilot/$threadId', params: { threadId }, search: { q: question } }),
        onError: () => {
          started.current = false;
        },
      },
    );
  };
  const startRef = useRef(start);
  startRef.current = start;

  useEffect(() => {
    if (initialQuestion && userId) startRef.current(initialQuestion);
  }, [initialQuestion, userId]);

  return (
    <CopilotShell
      title="New chat"
      composer={<CopilotComposer send={start} busy={!userId || create.isPending} stop={null} />}
    >
      {create.isError ? (
        <ErrorState title="Could not start the chat" retry={() => create.reset()} />
      ) : (
        <Flex direction="column" gap="6" data-testid="chat-conversation" data-new-chat="">
          <EmptyChat ask={start} />
        </Flex>
      )}
    </CopilotShell>
  );
};

/** One Copilot chat: its memory thread with the Ops Lead, streamed answers, and the composer at the bottom. */
export const CopilotChatPage = ({
  threadId,
  initialQuestion = null,
}: {
  threadId: string;
  initialQuestion?: string | null;
}) => {
  const me = useMe();
  const navigate = useNavigate();
  const asked = useRef(false);
  const userId = me.data?.id;
  const chats = useCopilotChats(userId);
  const history = useCopilotHistory(threadId);
  const stream = useCopilotStream(userId, threadId);
  const bottom = useRef<HTMLDivElement>(null);
  const turns = history.data ?? [];
  const ask = (question: string) => void stream.ask(question);
  const chat = chats.data?.find((item) => item.id === threadId) ?? null;
  const firstQuestion = turns[0]?.question ?? stream.live?.question ?? null;
  const title = chat?.title?.trim() || (firstQuestion ? chatTitleOf(firstQuestion) : chatTitle(null));
  const actions = useChatActions({ deleted: () => void navigate({ to: '/copilot' }) });

  // The question that opened the chat (or came from the Overview) is asked once, then dropped from the URL. Only
  // into an empty chat: revisiting an old ?q= link never asks it again.
  const storedTurns = history.data?.length ?? 0;
  useEffect(() => {
    if (!initialQuestion || asked.current || !userId || history.isPending) return;
    asked.current = true;
    if (!storedTurns) void stream.ask(initialQuestion);
    void navigate({ to: '/copilot/$threadId', params: { threadId }, search: {}, replace: true });
  }, [initialQuestion, userId, history.isPending, storedTurns, stream, navigate, threadId]);

  // Follow the answer while it streams, as carbonme's page.scroll.follow.
  const live = stream.live;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [live?.answer, live?.activity.items.length, turns.length]);

  return (
    <CopilotShell
      title={title}
      actions={
        <>
          <ChatActionsMenu item={{ id: threadId, title }} actions={actions} />
          {actions.dialogs}
        </>
      }
      composer={
        <CopilotComposer
          send={ask}
          busy={stream.streaming || !userId}
          stop={stream.streaming ? stream.stop : null}
        />
      }
    >
      {history.isPending || me.isPending ? (
        <ChatSkeleton />
      ) : history.isError ? (
        <ErrorState title="Could not load this chat" retry={() => void history.refetch()} />
      ) : (
        <Flex direction="column" gap="6" data-testid="chat-conversation">
          {!turns.length && !live && <EmptyChat ask={ask} />}
          {turns.map((turn) => (
            <Turn key={turn.id} turn={turn} retry={ask} />
          ))}
          {live && <Turn turn={live} retry={ask} />}
          {turns.length > 0 && !live && (
            <>
              <FollowUps items={SUGGESTED_PROMPTS.slice(0, 3)} send={ask} />
              <RecallSearch />
            </>
          )}
          <div ref={bottom} />
        </Flex>
      )}
    </CopilotShell>
  );
};
