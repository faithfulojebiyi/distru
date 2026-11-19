import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { Box, Flex, Grid, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { Button } from '@ops/ui/primitives/button';
import { Skeleton } from '@ops/ui/primitives/skeleton';
import { Heading, Span } from '@ops/ui/primitives/text';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@ops/ui/primitives/tooltip';
import type { ProposalSummary } from '../../api/generated/opsAgentAPI.schemas';
import { AuditRow } from '../audit/components/audit-log';
import { ProposalListSkeleton, ProposalRow } from '../proposals/components/proposal-inbox';
import {
  formatAge,
  formatMoneyShort,
  isThisWeek,
  isToday,
} from '../proposals/proposal-values';
import { useAuditEvents, useProposals } from '../proposals/proposals-api';
import { useMe } from '../session/session-api';
import { EmptyState, ErrorState, Panel, StatCard } from '../system/components/states';
import { useNow } from '../system/use-now';

const APPROVED: ReadonlySet<ProposalSummary['status']> = new Set([
  'approved',
  'auto_approved',
  'executing',
  'executed',
]);

const greeting = (now: number) => {
  const hour = new Date(now).getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
};

/** The figures on the stat cards, computed from the proposal list until the server has a stats route. */
const statsOf = (proposals: readonly ProposalSummary[], now: number) => {
  const pending = proposals.filter((p) => p.status === 'pending_approval');
  const week = proposals.filter((p) => isThisWeek(p.createdAt, now));
  const sum = (items: readonly ProposalSummary[]) =>
    items.reduce((total, p) => total + (p.totalValue ?? 0), 0);
  const oldest = pending.at(-1);
  return {
    pending: pending.length,
    pendingValue: sum(pending),
    oldestPending: oldest ? formatAge(oldest.createdAt, now) : null,
    autoToday: proposals.filter(
      (p) => p.policyOutcome === 'allow' && isToday(p.createdAt, now),
    ).length,
    executedToday: proposals.filter(
      (p) => p.status === 'executed' && isToday(p.updatedAt, now),
    ).length,
    failedToday: proposals.filter(
      (p) => p.status === 'failed' && isToday(p.updatedAt, now),
    ).length,
    proposedWeek: sum(week),
    approvedWeek: sum(week.filter((p) => APPROVED.has(p.status))),
    proposedWeekCount: week.length,
  };
};

/** Starting a run from the UI needs POST /api/runs on the agent server, which is not there yet. */
const StartRunButton = () => (
  <Tooltip>
    <TooltipTrigger asChild>
      <Box tabIndex={0} data-start-run="disabled">
        <Button size="sm" disabled pointerEvents="none" opacity="0.5">
          <Icons.play size={12} />
          Start restock run
        </Button>
      </Box>
    </TooltipTrigger>
    <TooltipContent>
      Coming soon. Until then, start a run from the CLI or ask Claude Code over MCP.
    </TooltipContent>
  </Tooltip>
);

const StatSkeleton = () => (
  <Flex direction="column" gap="2.5" p="4" rounded="xl" bg="brand.panel.2">
    <Skeleton h="3" w="50%" rounded="md" />
    <Skeleton h="7" w="40%" rounded="md" />
    <Skeleton h="2.5" w="70%" rounded="md" />
  </Flex>
);

export const OverviewPage = () => {
  const me = useMe();
  const proposals = useProposals();
  const activity = useAuditEvents({ order: 'desc', limit: 10 });
  const now = useNow(60_000);
  const nowDate = useMemo(() => new Date(now), [now]);

  const stats = useMemo(
    () => (proposals.data ? statsOf(proposals.data, now) : null),
    [proposals.data, now],
  );
  const titles = useMemo(
    () => new Map((proposals.data ?? []).map((p) => [p.id, p.title])),
    [proposals.data],
  );
  const needsDecision = (proposals.data ?? [])
    .filter((p) => p.status === 'pending_approval')
    .slice(0, 5);

  const firstName = me.data?.name.split(' ')[0];

  return (
    <Flex direction="column" gap="6" maxW="80rem" mx="auto" w="full">
      <Flex
        direction={{ base: 'column', md: 'row' }}
        justify="space-between"
        align={{ base: 'flex-start', md: 'flex-end' }}
        gap="4"
      >
        <Flex direction="column" gap="1">
          <Heading as="h2" fontSize="5" fontWeight="600" letterSpacing="-0.015em">
            {greeting(now)}
            {firstName ? `, ${firstName}` : ''}
          </Heading>
          <Span color="text.muted" fontSize="1.5">
            {stats === null
              ? 'Loading what the agents did…'
              : stats.pending > 0
                ? `${stats.pending} proposal${stats.pending === 1 ? '' : 's'} worth ${formatMoneyShort(stats.pendingValue)} ${stats.pending === 1 ? 'is' : 'are'} waiting for a decision.`
                : 'Nothing is waiting for a decision. The agents will propose changes as stock runs low.'}
          </Span>
        </Flex>
        <StartRunButton />
      </Flex>

      <Grid gridTemplateColumns={{ base: '1fr 1fr', lg: 'repeat(4, minmax(0, 1fr))' }} gap="3">
        {stats === null ? (
          proposals.isError ? null : (
            Array.from({ length: 4 }, (_, index) => <StatSkeleton key={index} />)
          )
        ) : (
          <>
            <Link to="/approvals" search={{ status: 'pending' }}>
              <StatCard
                icon={Icons.checkCircle}
                label="Pending approvals"
                value={stats.pending}
                tone={stats.pending === 0 ? 'muted' : undefined}
                accent={stats.pending > 0 ? 'palette.amber.9' : undefined}
                note={
                  stats.oldestPending
                    ? `Oldest proposed ${stats.oldestPending}`
                    : 'Inbox is clear'
                }
              />
            </Link>
            <StatCard
              icon={Icons.zap}
              label="Auto-approved today"
              value={stats.autoToday}
              tone={stats.autoToday === 0 ? 'muted' : undefined}
              note="Under the threshold, no high-risk ops"
            />
            <StatCard
              icon={Icons.database}
              label="Executed today"
              value={stats.executedToday}
              tone={stats.executedToday === 0 ? 'muted' : undefined}
              note={
                stats.failedToday > 0
                  ? `${stats.failedToday} failed today`
                  : 'Written and verified in Distru'
              }
            />
            <StatCard
              icon={Icons.dollar}
              label="Proposed this week"
              value={formatMoneyShort(stats.proposedWeek)}
              tone={stats.proposedWeek === 0 ? 'muted' : undefined}
              note={`${formatMoneyShort(stats.approvedWeek)} approved across ${stats.proposedWeekCount} proposal${stats.proposedWeekCount === 1 ? '' : 's'}`}
            />
          </>
        )}
      </Grid>

      {proposals.isError ? (
        <ErrorState title="Could not load proposals" retry={() => void proposals.refetch()} />
      ) : null}

      <Grid gridTemplateColumns={{ base: '1fr', xl: 'minmax(0, 1.25fr) minmax(0, 1fr)' }} gap="4" alignItems="start">
        <Panel
          title={
            <HStack gap="2">
              Needs your decision
              {stats && stats.pending > 0 ? (
                <styled.span
                  fontSize="1"
                  px="1.5"
                  rounded="full"
                  bg="palette.amber.9"
                  color="white"
                  fontVariantNumeric="tabular-nums"
                >
                  {stats.pending}
                </styled.span>
              ) : null}
            </HStack>
          }
          action={
            <Link to="/approvals" search={{ status: 'pending' }}>
              <Span _hover={{ color: 'text.app' }}>View all</Span>
            </Link>
          }
          data-testid="needs-decision"
        >
          {proposals.isPending ? (
            <ProposalListSkeleton rows={3} />
          ) : needsDecision.length === 0 ? (
            <EmptyState
              compact
              illustration="notification"
              title="You are all caught up"
              hint="New proposals that need a human land here."
            />
          ) : (
            <Flex direction="column" gap="1">
              {needsDecision.map((proposal) => (
                <ProposalRow key={proposal.id} proposal={proposal} now={now} compact />
              ))}
            </Flex>
          )}
        </Panel>
        <Panel
          title="Recent activity"
          action={
            <Link to="/audit">
              <Span _hover={{ color: 'text.app' }}>Audit log</Span>
            </Link>
          }
          data-testid="recent-activity"
        >
          {activity.isPending ? (
            <Flex direction="column" gap="1">
              {Array.from({ length: 5 }, (_, index) => (
                <Skeleton key={index} h="12" rounded="lg" />
              ))}
            </Flex>
          ) : activity.isError ? (
            <Span color="text.muted">Could not load recent activity.</Span>
          ) : activity.data.length === 0 ? (
            <EmptyState compact illustration="reports" title="No activity yet" hint="Proposals, decisions and writes show here as they happen." />
          ) : (
            <Flex direction="column" gap="1">
              {activity.data.map((event) => (
                <AuditRow
                  key={event.id}
                  event={event}
                  now={nowDate}
                  title={event.proposalId ? (titles.get(event.proposalId) ?? null) : null}
                />
              ))}
            </Flex>
          )}
        </Panel>
      </Grid>
    </Flex>
  );
};
