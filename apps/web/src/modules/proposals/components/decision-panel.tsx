import { useState } from 'react';
import { Box, Flex, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { Button } from '@ops/ui/primitives/button';
import { Textarea } from '@ops/ui/primitives/textarea';
import { Span } from '@ops/ui/primitives/text';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@ops/ui/primitives/tooltip';
import type {
  DecisionKind,
  ProposalDetail,
} from '../../../api/generated/opsAgentAPI.schemas';
import { useMe } from '../../session/session-api';
import { actorName, formatDateTime, formatMoney } from '../proposal-values';
import {
  decisionFailureOf,
  useDecideProposal,
  type DecisionFailure,
} from '../proposals-api';
import { AMBER_TINT } from './badges';
import { PolicyReasons } from './policy-panel';

const FailureNotice = ({ failure }: { failure: DecisionFailure }) => (
  <Flex
    direction="column"
    gap="2"
    px="3"
    py="2.5"
    rounded="lg"
    bg={failure.kind === 'conflict' ? AMBER_TINT : 'brand.error.3'}
    color={failure.kind === 'conflict' ? 'palette.amber.11' : 'text.error'}
    fontSize="1.5"
    role="alert"
    data-decision-failure={failure.kind}
  >
    <HStack gap="2" alignItems="flex-start">
      <Icons.warn size={14} flexShrink="0" mt="0.5" />
      <span>
        {failure.kind === 'policy_denied'
          ? 'Policy blocked this approval. Nothing was recorded.'
          : failure.message}
      </span>
    </HStack>
    {failure.kind === 'policy_denied' && (
      <Box color="text.app">
        <PolicyReasons reasons={failure.evaluation.reasons} />
      </Box>
    )}
  </Flex>
);

/** Approve / reject with an optional reason, for approvers; operators see why they cannot. */
const DecisionForm = ({ proposal }: { proposal: ProposalDetail }) => {
  const me = useMe();
  const decide = useDecideProposal(proposal.id);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<DecisionKind | null>(null);
  const allowed = me.data?.canApprove ?? false;
  const failure = decide.error ? decisionFailureOf(decide.error) : null;
  const busy = decide.isPending;

  const send = (decision: DecisionKind) => {
    setPending(decision);
    decide.mutate(
      { decision, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      { onSettled: () => setPending(null) },
    );
  };

  const spinner = (decision: DecisionKind) =>
    pending === decision ? <Icons.loading size={13} /> : null;

  const buttons = (
    <HStack gap="2" justify="flex-end" flexWrap="wrap">
      <Button
        size="sm"
        variant="soft"
        disabled={!allowed || busy}
        onClick={() => send('reject')}
        data-decide="reject"
      >
        {spinner('reject')}
        Reject
      </Button>
      <Button
        size="sm"
        disabled={!allowed || busy}
        onClick={() => send('approve')}
        data-decide="approve"
      >
        {spinner('approve') ?? <Icons.check size={13} />}
        Approve {formatMoney(proposal.totalValue)}
      </Button>
    </HStack>
  );

  return (
    <Flex direction="column" gap="3">
      <Textarea
        placeholder={
          allowed
            ? 'Reason (optional): shown in the audit log'
            : 'Only approvers can decide'
        }
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        maxLength={2000}
        rows={3}
        disabled={!allowed || busy}
        aria-label="Decision reason"
        bg="background.app"
      />
      {failure && <FailureNotice failure={failure} />}
      {allowed ? (
        buttons
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Box alignSelf="flex-end" tabIndex={0} data-decide-locked="">
              <Box pointerEvents="none" opacity="0.55">{buttons}</Box>
            </Box>
          </TooltipTrigger>
          <TooltipContent>
            You are signed in as an operator. Ask an approver to decide.
          </TooltipContent>
        </Tooltip>
      )}
    </Flex>
  );
};

const DecisionRecord = ({ proposal }: { proposal: ProposalDetail }) => {
  const decision = proposal.decision;
  if (!decision) return null;
  const approved = decision.decision === 'approve';
  return (
    <HStack
      gap="2.5"
      alignItems="flex-start"
      px="3"
      py="2.5"
      rounded="lg"
      bg="background.app"
      fontSize="1.5"
      data-decision={decision.decision}
    >
      <styled.span
        color={approved ? 'palette.green.11' : 'text.muted'}
        pt="0.5"
      >
        {approved ? <Icons.checkCircle size={14} /> : <Icons.closeCircle size={14} />}
      </styled.span>
      <Flex direction="column" gap="0.5" minW="0">
        <span>
          <Span fontWeight="500">{actorName(decision.by)}</Span>{' '}
          {approved ? 'approved' : 'rejected'}
          {decision.edited ? ' with edits' : ''}
        </span>
        {decision.reason ? (
          <Span color="text.muted" fontSize="1">
            “{decision.reason}”
          </Span>
        ) : null}
        <Span color="text.muted" fontSize="1">
          {formatDateTime(decision.at)}
        </Span>
      </Flex>
    </HStack>
  );
};

const NOTES: Partial<Record<ProposalDetail['status'], string>> = {
  auto_approved:
    'Policy approved this automatically: it is under the auto-approve threshold and no op is high risk.',
  denied:
    'Policy denied this proposal, so it cannot be approved. Ask the agent to revise it.',
  draft: 'Still being planned. It can be decided once it is submitted.',
};

/** What a person can do with this proposal now: decide it, or see who did and when. */
export const DecisionPanel = ({ proposal }: { proposal: ProposalDetail }) => {
  const note = NOTES[proposal.status];
  return (
    <Flex
      direction="column"
      gap="3"
      p="4"
      rounded="xl"
      bg={proposal.status === 'pending_approval' ? AMBER_TINT : 'brand.panel.2'}
      data-testid="decision-panel"
    >
      <HStack gap="2">
        {proposal.status === 'pending_approval' ? (
          <styled.span w="1.5" h="1.5" rounded="full" bg="palette.amber.9" />
        ) : null}
        <Span fontWeight="600" fontSize="1.5">
          {proposal.status === 'pending_approval' ? 'Your decision' : 'Decision'}
        </Span>
      </HStack>
      {proposal.status === 'pending_approval' ? (
        <DecisionForm proposal={proposal} />
      ) : (
        <>
          <DecisionRecord proposal={proposal} />
          {note ? (
            <Span color="text.muted" fontSize="1.5">
              {note}
            </Span>
          ) : null}
        </>
      )}
    </Flex>
  );
};
