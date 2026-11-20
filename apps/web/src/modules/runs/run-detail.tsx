// Shell adapted from carbonme modules/chats/chat-shell.tsx (breadcrumb bar over a scrolling column); the trace is the
// carbonme live-steps timeline (steps/step-timeline.tsx), the Tasks tray (steps/tasks-tray.tsx), the failed-run box of
// chat-page.tsx LastRun, and the token/cost bar of carbonme modules/usage/run-cost.tsx.
import { Link } from '@tanstack/react-router';
import { Box, Flex, Grid, HStack, styled } from '@ops/ui/jsx';

import type { RunDetail } from '../../api/generated/opsAgentAPI.schemas';
import { isNotFoundError } from '../../api/errors';
import { Icons } from '@ops/ui/icons/base';
import { Skeleton } from '@ops/ui/primitives/skeleton';
import { Span } from '@ops/ui/primitives/text';
import { StatusBadge } from '../proposals/components/badges';
import { formatDateTime, formatMoney } from '../proposals/proposal-values';
import { ApprovalWaitCard, LinkPill } from '../steps/step-cards';
import {
  durationText,
  formatCost,
  formatTokens,
  plural,
} from '../steps/step-activity-data';
import { StepTimeline } from '../steps/step-timeline';
import { TasksTray } from '../steps/tasks-tray';
import { ErrorState } from '../system/components/states';
import { useNow } from '../system/use-now';
import { runActivityOf, triggerOf } from './run-activity';
import { RunStatusBadge } from './run-badges';
import { LIVE_RUN_STATUSES, useRun, useRunLabel } from './runs-api';

const Breadcrumb = ({ runId }: { runId: string }) => (
  <HStack
    as="nav"
    aria-label="Breadcrumb"
    gap="1.5"
    fontSize="1.5"
    minW="0"
    h="11"
    flexShrink="0"
    borderBottomWidth="1px"
    borderColor="border.subtle"
    pl={{ base: '12', md: '6' }}
    pr={{ base: '4', md: '6' }}
  >
    <Link to="/runs" style={{ flexShrink: 0 }}>
      <styled.span color="text.muted" _hover={{ color: 'text.app' }}>
        Runs
      </styled.span>
    </Link>
    <styled.span color="text.muted" aria-hidden>
      <Icons.caretRight size={12} />
    </styled.span>
    <styled.h1 color="text.app" fontWeight="500" truncate minW="0" aria-current="page">
      Restock run{' '}
      <styled.span fontFamily="mono" fontSize="1" color="text.muted">
        {runId.slice(0, 8)}
      </styled.span>
    </styled.h1>
  </HStack>
);

/** The run's tokens and cost, as carbonme's RunCost bar. */
const RunTotals = ({ run }: { run: RunDetail }) => (
  <HStack
    gap="2"
    px="2.5"
    py="2"
    rounded="lg"
    bg="brand.panel.3"
    color="text.muted"
    fontSize="1"
    data-run-totals=""
  >
    <Icons.stack size={13} />
    <Span flex="1">
      {plural(run.totals.agentCalls, 'agent call')} · {plural(run.totals.toolCalls, 'tool call')} ·{' '}
      {formatTokens(run.totals.tokens.input)} in · {formatTokens(run.totals.tokens.output)} out
    </Span>
    <Span color="text.app" fontWeight="600" fontVariantNumeric="tabular-nums">
      {formatCost(run.totals.costUsd)}
    </Span>
  </HStack>
);

const Fact = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <Flex direction="column" gap="0.5" minW="0">
    <styled.span fontSize="1" color="text.muted">
      {label}
    </styled.span>
    <styled.span fontSize="1.5" truncate fontVariantNumeric="tabular-nums">
      {children}
    </styled.span>
  </Flex>
);

const RunHeader = ({ run, now }: { run: RunDetail; now: number }) => {
  const trigger = triggerOf(run.triggeredBy);
  const live = LIVE_RUN_STATUSES.has(run.status) && run.status !== 'suspended';
  const end = live ? now : Date.parse(run.updatedAt);
  const labelOf = useRunLabel();
  return (
    <Flex direction="column" gap="4">
      <HStack gap="3" flexWrap="wrap">
        <styled.h2 fontSize={{ base: '4', md: '5' }} fontWeight="600" letterSpacing="-0.015em" title={run.runId}>
          {labelOf(run)}
        </styled.h2>
        <RunStatusBadge status={run.status} />
      </HStack>
      <Grid gridTemplateColumns={{ base: '1fr 1fr', md: 'repeat(4, minmax(0, 1fr))' }} gap="4">
        <Fact label="Trigger">
          {trigger.label}
          {trigger.by ? ` · ${trigger.by}` : ''}
        </Fact>
        <Fact label="Started">{formatDateTime(run.createdAt)}</Fact>
        <Fact label="Duration">{durationText(end - Date.parse(run.createdAt))}</Fact>
        <Fact label="Scope">
          {typeof run.input?.scenarioNote === 'string' ? run.input.scenarioNote : 'All locations and vendors'}
        </Fact>
      </Grid>
    </Flex>
  );
};

/** A failed run says why (carbonme LastRun's failed box). */
const RunFailure = ({ error }: { error: string }) => (
  <Box role="alert" rounded="xl" bg="brand.error.3" px="4" py="3" data-run-error="">
    <HStack gap="2" alignItems="start">
      <Icons.warn size={15} color="text.error" flexShrink="0" mt="0.5" />
      <styled.p fontSize="1.5" color="text.error" flex="1" whiteSpace="pre-wrap" overflowWrap="anywhere">
        {error}
      </styled.p>
    </HStack>
  </Box>
);

const ProposalLink = ({ run }: { run: RunDetail }) => {
  if (!run.proposal) return null;
  return (
    <LinkPill
      to="/approvals/$proposalId"
      params={{ proposalId: run.proposal.id }}
      icon={<Icons.editSquare size={14} />}
      name="Proposal"
      detail={formatMoney(run.proposal.totalValue)}
      badge={<StatusBadge status={run.proposal.status} />}
    />
  );
};

const RunBody = ({ run }: { run: RunDetail }) => {
  const live = LIVE_RUN_STATUSES.has(run.status);
  const now = useNow(live ? 1_000 : 60_000);
  const activity = runActivityOf(run);
  const suspended = run.status === 'suspended' || run.status === 'paused';
  const waitCard = suspended ? (
    <Box mt="1.5" mb="1">
      <ApprovalWaitCard
        proposalId={run.proposal?.id ?? null}
        title={run.proposal?.title ?? null}
        value={run.proposal ? formatMoney(run.proposal.totalValue) : null}
      />
    </Box>
  ) : null;

  return (
    <Grid
      gridTemplateColumns={{ base: '1fr', xl: 'minmax(0, 1fr) 20rem' }}
      gap={{ base: '6', xl: '10' }}
      alignItems="start"
      maxW="72rem"
      mx="auto"
      w="full"
    >
      <Flex direction="column" gap="5" minW="0">
        <RunHeader run={run} now={now} />
        {run.error && <RunFailure error={run.error} />}
        <StepTimeline
          activity={activity}
          answering={false}
          live={live}
          awaiting={suspended}
          defaultOpen
          slots={waitCard ? { 'await-decision': waitCard } : undefined}
        />
        {suspended && !run.steps.some((step) => step.stepId === 'await-decision') && waitCard}
      </Flex>
      <Flex direction="column" gap="3" minW="0" position={{ xl: 'sticky' }} top={{ xl: '0' }}>
        <TasksTray tasks={activity.tasks} activity={activity} docked={false} />
        <RunTotals run={run} />
        <ProposalLink run={run} />
      </Flex>
    </Grid>
  );
};

/** One run: its header, the agent trace as live steps, its Tasks, totals and proposal; polls while it runs. */
export const RunDetailPage = ({ runId }: { runId: string }) => {
  const run = useRun(runId);
  return (
    <Flex direction="column" h="full" minH="0" bg="background.app">
      <Breadcrumb runId={runId} />
      <Box flex="1" minH="0" overflowY="auto" style={{ scrollbarGutter: 'stable' }}>
        <Box px={{ base: '4', md: '8' }} pt={{ base: '6', md: '8' }} pb="16">
          {run.isPending ? (
            <Flex direction="column" gap="4" maxW="72rem" mx="auto" aria-hidden>
              <Skeleton h="8" w="40%" rounded="lg" />
              <Skeleton h="4" w="80%" />
              <Skeleton h="4" w="70%" />
              <Skeleton h="4" w="75%" />
            </Flex>
          ) : run.isError ? (
            <ErrorState
              title={isNotFoundError(run.error) ? 'Run not found' : 'Could not load this run'}
              hint={isNotFoundError(run.error) ? 'It may belong to another workflow, or its id is wrong.' : undefined}
              retry={isNotFoundError(run.error) ? undefined : () => void run.refetch()}
            />
          ) : (
            <RunBody run={run.data} />
          )}
        </Box>
      </Box>
    </Flex>
  );
};
