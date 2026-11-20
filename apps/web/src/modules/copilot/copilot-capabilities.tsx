// The new-chat page's "What I can help with", adapted from carbonme modules/chats/new-chat-page.tsx (the Empty state
// that says what a new Chat can do) and chat-answer-feedback.tsx's follow-up chips (via FollowUps' Chip here), laid
// out as the chat mockup's compact list: a topic, where its answers come from, and example questions to click.
import { Box, Flex, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { Skeleton } from '@ops/ui/primitives/skeleton';
import type { CopilotTopic } from '../../api/generated/opsAgentAPI.schemas';
import { useCopilotCapabilities } from './copilot-api';
import { SUGGESTED_PROMPTS } from './copilot-data';
import { FollowUps, QuestionChip } from './copilot-messages';

const TopicRow = ({ topic, send }: { topic: CopilotTopic; send: (question: string) => void }) => (
  <styled.li
    listStyle="none"
    display="grid"
    gridTemplateColumns={{ base: '1fr', md: '11rem minmax(0, 1fr)' }}
    columnGap="4"
    rowGap="1.5"
    py="2.5"
    borderBottomWidth="1px"
    borderColor="border.subtle"
    _last={{ borderBottomWidth: '0' }}
    data-capability={topic.id}
  >
    <Box minW="0">
      <styled.p fontSize="1.5" fontWeight="500">
        {topic.title}
      </styled.p>
      <styled.p fontSize="1" color="text.muted" lineHeight="1.45">
        {topic.source}
      </styled.p>
    </Box>
    <Flex gap="1.5" flexWrap="wrap" alignContent="flex-start" minW="0">
      {topic.examples.slice(0, 2).map((example) => (
        <QuestionChip key={example} question={example} send={send} />
      ))}
    </Flex>
  </styled.li>
);

/** What the Ops Lead can answer (from its current tools, GET /api/copilot/capabilities) and what it can't. */
export const CopilotCapabilities = ({ send }: { send: (question: string) => void }) => {
  const capabilities = useCopilotCapabilities();

  if (capabilities.isPending)
    return (
      <Flex direction="column" gap="2" mt="6" aria-hidden>
        {[0, 1, 2, 3].map((row) => (
          <Skeleton key={row} h="9" rounded="lg" />
        ))}
      </Flex>
    );

  // Without the list, the suggested questions still give a start.
  if (capabilities.isError)
    return (
      <Flex justify="center">
        <FollowUps items={SUGGESTED_PROMPTS} send={send} />
      </Flex>
    );

  const { topics, cannotDo, dataset } = capabilities.data;
  return (
    <Box mt="6" data-copilot-capabilities="">
      <HStack gap="2" mb="1" color="text.muted">
        <Icons.sparkle size={13} />
        <styled.h2 fontSize="1" fontWeight="500" letterSpacing="0.025em">
          What I can help with
        </styled.h2>
      </HStack>
      <styled.ul p="0" m="0">
        {topics.map((topic) => (
          <TopicRow key={topic.id} topic={topic} send={send} />
        ))}
      </styled.ul>
      <Box mt="4" px="3" py="2.5" rounded="xl" bg="brand.panel.3" data-copilot-cannot-do="">
        <styled.p fontSize="1" fontWeight="500" color="text.muted" mb="1">
          Can’t do in this demo
        </styled.p>
        <styled.ul p="0" m="0" display="flex" flexDirection="column" gap="1">
          {cannotDo.map((line) => (
            <styled.li key={line} listStyle="none" fontSize="1" color="text.muted" lineHeight="1.45">
              {line}
            </styled.li>
          ))}
        </styled.ul>
        <styled.p fontSize="1" color="text.muted" mt="1.5">
          Data: {dataset}
        </styled.p>
      </Box>
    </Box>
  );
};
