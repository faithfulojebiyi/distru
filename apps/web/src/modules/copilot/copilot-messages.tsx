// Adapted from carbonme modules/chats: chat-question.tsx (SentQuestion bubble), chat-answer.tsx (StreamingAnswer,
// ANSWER_HEADINGS, CopyAnswer, StoppedAnswer, AnswerPending), chat-answer-feedback.tsx (Chip, FollowUps),
// chat-page.tsx (LastRun's failed box, AssistantMessage order: steps → tool runs → answer) and
// knowledge/knowledge-layout.tsx (Empty).
import { Box, Flex, HStack, styled } from '@ops/ui/jsx';

import { ThinkingOrb } from '@ops/ui/blocks/thinking-orb';
import { Icons } from '@ops/ui/icons/base';
import { Button } from '@ops/ui/primitives/button';
import { MarkdownDocument } from '@ops/ui/primitives/markdown';
import { ANSWER_COMPONENTS } from './answer-components';
import { toast } from '@ops/ui/primitives/toast/toast';
import { StatusBadge } from '../proposals/components/badges';
import { ProposalStatus } from '../../api/generated/opsAgentAPI.schemas';
import { LinkPill } from '../steps/step-cards';
import { StepTimeline } from '../steps/step-timeline';
import { ToolRuns } from '../steps/tool-runs';
import type { CopilotLink, CopilotTurn } from './copilot-data';

/** A sent question: its text in a bubble, right-aligned. */
export const SentQuestion = ({ text }: { text: string }) => (
  <Flex direction="column" align="flex-end" gap="1.5" data-message="user">
    <styled.p
      maxW="85%"
      px="4"
      py="2.5"
      rounded="2xl"
      bg="brand.panel.3"
      fontSize="2"
      lineHeight="1.6"
      whiteSpace="pre-wrap"
      overflowWrap="anywhere"
    >
      {text}
    </styled.p>
  </Flex>
);

/** Headings stay close to the answer's body size, so an answer never reads as a page. */
const ANSWER_HEADINGS = {
  '& h1': { fontSize: '3' },
  '& h2': { fontSize: '2' },
  '& h3': { fontSize: '2' },
} as const;

/** Shown before any step or word arrives. */
export const AnswerPending = () => (
  <HStack gap="2" color="text.muted" fontSize="1" role="status" data-answer="pending">
    <ThinkingOrb state="working" size={20} aria-label="Thinking" />
    Thinking…
  </HStack>
);

const CopyAnswer = ({ text }: { text: string }) => (
  <Button
    size="icon"
    variant="ghost"
    color="text.muted"
    ml="auto"
    aria-label="Copy answer"
    title="Copy"
    onClick={() =>
      void navigator.clipboard
        .writeText(text)
        .then(() => toast.success('Answer copied.'))
        .catch(() => toast.error('Could not copy the answer.'))
    }
    data-answer-copy=""
  >
    <Icons.copy size={14} />
  </Button>
);

const isProposalStatus = (value: string | null): value is ProposalStatus =>
  value !== null && value in ProposalStatus;

/** A run the answer started or a proposal it created, as carbonme's workflow pill. */
const AnswerLink = ({ link }: { link: CopilotLink }) =>
  link.kind === 'run' ? (
    <LinkPill
      to="/runs/$runId"
      params={{ runId: link.runId }}
      icon={<Icons.play size={14} />}
      name="Restock run"
      detail={`${link.runId.slice(0, 8)} · watch it step by step`}
    />
  ) : (
    <LinkPill
      to="/approvals/$proposalId"
      params={{ proposalId: link.proposalId }}
      icon={<Icons.editSquare size={14} />}
      name="Proposal"
      detail="review the diff and decide"
      badge={isProposalStatus(link.status) ? <StatusBadge status={link.status} /> : undefined}
    />
  );

/** The failed box of carbonme's LastRun. */
const AnswerFailure = ({ error, retry }: { error: string; retry: () => void }) => (
  <Box role="alert" rounded="xl" bg="brand.error.3" px="4" py="3" data-answer="error">
    <HStack gap="2" alignItems="start">
      <Icons.warn size={15} color="text.error" flexShrink="0" mt="0.5" />
      <styled.p fontSize="2" color="text.error" flex="1">
        {error}
      </styled.p>
    </HStack>
    <HStack justify="flex-end" mt="2">
      <Button size="xs" variant="ghost" rounded="full" onClick={retry}>
        <Icons.refresh size={12} />
        Try again
      </Button>
    </HStack>
  </Box>
);

/** One assistant turn: the steps it took, its tool cards, the answer as Markdown, and links to what it made. */
export const AssistantTurn = ({
  turn,
  retry,
}: {
  turn: CopilotTurn;
  retry: (question: string) => void;
}) => {
  const live = turn.status === 'streaming';
  const nothingYet = live && !turn.answer && !turn.activity.items.length;
  return (
    <Flex direction="column" gap="3" data-message="assistant" data-turn-status={turn.status}>
      {nothingYet ? (
        <AnswerPending />
      ) : (
        <StepTimeline activity={turn.activity} answering={Boolean(turn.answer)} live={live} />
      )}
      <ToolRuns runs={turn.tools} />
      {turn.answer ? (
        <Box css={ANSWER_HEADINGS} data-answer={live ? 'streaming' : 'answered'} aria-live="off">
          <MarkdownDocument text={turn.answer} variant="answer" streaming={live} components={ANSWER_COMPONENTS} />
        </Box>
      ) : null}
      {turn.links.length > 0 && (
        <Flex direction="column" gap="1.5" data-answer-links="">
          {turn.links.map((link) => (
            <AnswerLink key={link.kind === 'run' ? link.runId : link.proposalId} link={link} />
          ))}
        </Flex>
      )}
      {turn.status === 'stopped' && (
        <styled.p fontSize="1" color="text.muted" fontStyle="italic" data-answer="stopped">
          Answer stopped.
        </styled.p>
      )}
      {turn.status === 'failed' && (
        <AnswerFailure error={turn.error ?? 'The Copilot could not answer.'} retry={() => retry(turn.question)} />
      )}
      {turn.status === 'done' && turn.answer && (
        <Flex align="center" gap="1.5" data-answer-bar="">
          <CopyAnswer text={turn.answer} />
        </Flex>
      )}
    </Flex>
  );
};

/** A pill the size of the composer's chips: a soft panel shade, deeper while it is on. */
const Chip = styled('button', {
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '1.5',
    h: '7',
    px: '2.5',
    rounded: 'full',
    bg: 'brand.panel.4',
    color: 'text.muted',
    fontSize: '1',
    fontWeight: '500',
    cursor: 'pointer',
    transition: 'background 0.12s',
    minW: '0',
    _hover: { bg: 'brand.panel.6' },
    _focusVisible: { outline: '2px solid', outlineColor: 'brand.info.9' },
  },
});

/** Suggested questions as chips; one click asks it. */
export const FollowUps = ({
  items,
  send,
}: {
  items: readonly string[];
  send: (question: string) => void;
}) => {
  if (!items.length) return null;

  return (
    <Flex gap="1.5" flexWrap="wrap" mt="3" role="group" aria-label="Suggested questions" data-follow-ups="">
      {items.map((item) => (
        <Chip key={item} type="button" title={item} maxW="full" onClick={() => send(item)}>
          <Icons.arrowRight size={12} flexShrink="0" />
          <styled.span truncate minW="0">
            {item}
          </styled.span>
        </Chip>
      ))}
    </Flex>
  );
};

/** The empty thread (carbonme new-chat-page Empty). */
export const Empty = ({ title, detail }: { title: string; detail: string }) => (
  <Flex direction="column" align="center" gap="2" py={{ base: '14', md: '20' }} textAlign="center">
    <ThinkingOrb state="breathing" tone="agent" size={64} />
    <styled.p fontWeight="600" mt="3">
      {title}
    </styled.p>
    <styled.p color="text.muted" fontSize="2" maxW="30rem">
      {detail}
    </styled.p>
  </Flex>
);
