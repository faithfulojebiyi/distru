// Adapted from carbonme modules/chats/chat-page.tsx (ChatConversation: messages, the live run, follow-to-bottom) and
// new-chat-page.tsx (the empty state with suggested prompts).
import { useEffect, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Flex, Box } from '@ops/ui/jsx';
import { Skeleton } from '@ops/ui/primitives/skeleton';

import { useMe } from '../session/session-api';
import { ErrorState } from '../system/components/states';
import { useCopilotHistory, useCopilotStream } from './copilot-api';
import { SUGGESTED_PROMPTS, type CopilotTurn } from './copilot-data';
import { CopilotComposer } from './copilot-composer';
import { AssistantTurn, Empty, FollowUps, SentQuestion } from './copilot-messages';
import { CopilotShell } from './copilot-shell';

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

/** The Copilot: one memory thread per user with the Ops Lead, streamed answers, and the composer at the bottom. */
export const CopilotPage = ({ initialQuestion = null }: { initialQuestion?: string | null }) => {
  const me = useMe();
  const navigate = useNavigate();
  const asked = useRef(false);
  const userId = me.data?.id;
  const history = useCopilotHistory(userId);
  const stream = useCopilotStream(userId);
  const bottom = useRef<HTMLDivElement>(null);
  const turns = history.data ?? [];
  const ask = (question: string) => void stream.ask(question);

  // A question handed over from the Overview composer is asked once, then dropped from the URL.
  useEffect(() => {
    if (!initialQuestion || asked.current || !userId || history.isPending) return;
    asked.current = true;
    void stream.ask(initialQuestion);
    void navigate({ to: '/copilot', search: {}, replace: true });
  }, [initialQuestion, userId, history.isPending, stream, navigate]);

  // Follow the answer while it streams, as carbonme's page.scroll.follow.
  const live = stream.live;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [live?.answer, live?.activity.items.length, turns.length]);

  return (
    <CopilotShell
      title="Ops Lead"
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
        <ErrorState title="Could not load your Copilot thread" retry={() => void history.refetch()} />
      ) : (
        <Flex direction="column" gap="6" data-testid="chat-conversation">
          {!turns.length && !live && (
            <Box>
              <Empty
                title="Ask the Ops Lead"
                detail="It hands work to the Inventory Analyst, Procurement Planner, Compliance Reviewer and Policy Critic, and can start a restock run. It never writes to Distru."
              />
              <Flex justify="center">
                <FollowUps items={SUGGESTED_PROMPTS} send={ask} />
              </Flex>
            </Box>
          )}
          {turns.map((turn) => (
            <Turn key={turn.id} turn={turn} retry={ask} />
          ))}
          {live && <Turn turn={live} retry={ask} />}
          {turns.length > 0 && !live && (
            <FollowUps items={SUGGESTED_PROMPTS.slice(0, 3)} send={ask} />
          )}
          <div ref={bottom} />
        </Flex>
      )}
    </CopilotShell>
  );
};
