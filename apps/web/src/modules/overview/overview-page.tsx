// Adapted from carbonme modules/layout/components/workspace-home.tsx (header bar, date eyebrow, two-line greeting,
// the large composer, then tabbed collections with TabButton) and workspace-home-data.ts (homeDate); the figures use
// carbonme apps/admin/src/ui/stat-card.tsx. The composer hands its question to the Copilot.
import { css } from '@ops/ui/css';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Box, Flex, Grid, HStack, styled } from '@ops/ui/jsx';

import type { ProposalSummary } from '../../api/generated/opsAgentAPI.schemas';
import { Skeleton } from '@ops/ui/primitives/skeleton';
import { AuditRow } from '../audit/components/audit-log';
import { CopilotComposer } from '../copilot/copilot-composer';
import { ProposalListSkeleton, ProposalRow } from '../proposals/components/proposal-inbox';
import {
  formatAge,
  formatMoneyShort,
  isThisWeek,
  isToday,
} from '../proposals/proposal-values';
import { useAuditEvents, useProposals } from '../proposals/proposals-api';
import { RunStatusBadge } from '../runs/run-badges';
import { triggerOf } from '../runs/run-activity';
import { useRuns } from '../runs/runs-api';
import { StartRunButton } from '../runs/start-run-dialog';
import { useMe } from '../session/session-api';
import { EmptyState, ErrorState } from '../system/components/states';
import { StatCard } from '../system/components/stat-card';
import { formatCost, formatTokens } from '../steps/step-activity-data';
import { useNow } from '../system/use-now';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const;

/** `28 SEP 2026`: the viewer's local date, with three-letter months in every locale. */
const homeDate = (now = new Date()) =>
  `${String(now.getDate()).padStart(2, '0')} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`;

const APPROVED: ReadonlySet<ProposalSummary['status']> = new Set([
  'approved',
  'auto_approved',
  'executing',
  'executed',
]);

/** The figures on the stat cards, from the proposal list's own fields (totalValue, maxRisk, opSummaries). */
const statsOf = (proposals: readonly ProposalSummary[], now: number) => {
  const pending = proposals.filter((p) => p.status === 'pending_approval');
  const week = proposals.filter((p) => isThisWeek(p.createdAt, now));
  const sum = (items: readonly ProposalSummary[]) =>
    items.reduce((total, p) => total + (p.totalValue ?? 0), 0);
  /** Ops the executor wrote, from each proposal's op summaries (a partly failed proposal still wrote some). */
  const writes = (items: readonly ProposalSummary[]) =>
    items.reduce((total, p) => total + p.opSummaries.filter((op) => op.status === 'executed').length, 0);
  const oldest = pending.at(-1);
  const finishedToday = proposals.filter((p) => isToday(p.updatedAt, now));
  const autoToday = proposals.filter((p) => p.policyOutcome === 'allow' && isToday(p.createdAt, now));
  return {
    pending: pending.length,
    pendingValue: sum(pending),
    pendingHighRisk: pending.filter((p) => p.maxRisk === 'high').length,
    oldestPending: oldest ? formatAge(oldest.createdAt, now) : null,
    autoToday: autoToday.length,
    autoTodayValue: sum(autoToday),
    executedToday: finishedToday.filter((p) => p.status === 'executed').length,
    writesToday: writes(finishedToday.filter((p) => p.status === 'executed' || p.status === 'failed')),
    failedToday: finishedToday.filter((p) => p.status === 'failed').length,
    proposedWeek: sum(week),
    approvedWeek: sum(week.filter((p) => APPROVED.has(p.status))),
    proposedWeekCount: week.length,
    undoWeek: week.filter((p) => p.undoOf !== null).length,
  };
};

type HomeTab = 'decide' | 'runs' | 'activity';

/** A tab label with its small muted count. */
const TabButton = ({
  label,
  count,
  active,
  select,
}: {
  label: string;
  count: string | undefined;
  active: boolean;
  select: () => void;
}) => (
  <styled.button
    type="button"
    role="tab"
    aria-selected={active}
    onClick={select}
    display="flex"
    alignItems="start"
    gap="1"
    px="2"
    py="1"
    rounded="md"
    fontSize="2"
    fontWeight={active ? '500' : '400'}
    color={active ? 'text.app' : 'text.muted'}
    cursor="pointer"
    _hover={{ color: 'text.app' }}
  >
    {label}
    {count !== undefined && (
      <styled.span fontSize="0.625rem" color="text.muted" lineHeight="1">
        {count}
      </styled.span>
    )}
  </styled.button>
);

const ListSkeleton = () => (
  <Flex direction="column" gap="2" aria-hidden>
    {[0, 1, 2].map((row) => (
      <Skeleton key={row} h="12" rounded="lg" />
    ))}
  </Flex>
);

/** Recent runs as carbonme's ChatList rows: icon, title, status, time. */
const RunList = ({ now }: { now: number }) => {
  const runs = useRuns();
  if (runs.isPending) return <ListSkeleton />;
  if (runs.isError) return <ErrorState title="Could not load runs" retry={() => void runs.refetch()} />;
  if (!runs.data.length)
    return (
      <styled.p color="text.muted" fontSize="2" py="10" textAlign="center">
        Start a restock run to see the agents work.
      </styled.p>
    );
  return (
    <styled.ul display="flex" flexDirection="column" data-testid="home-runs">
      {runs.data.slice(0, 6).map((run) => (
        <li key={run.runId}>
          <Link to="/runs/$runId" params={{ runId: run.runId }}>
            <HStack
              gap="3"
              px="3"
              py="3"
              rounded="lg"
              borderBottomWidth="1px"
              borderColor="border.subtle"
              _hover={{ bg: 'background.muted' }}
            >
              <styled.span flex="1" minW="0" truncate fontSize="2">
                Restock run
                <styled.span color="text.muted" fontSize="1" ml="2">
                  {triggerOf(run.triggeredBy).label}
                </styled.span>
              </styled.span>
              <styled.span fontSize="1" color="text.muted" flexShrink="0" fontVariantNumeric="tabular-nums" hideBelow="md">
                {run.totals.agentCalls > 0 ? `${formatTokens(run.totals.tokens.total)} tok · ${formatCost(run.totals.costUsd)}` : ''}
              </styled.span>
              <RunStatusBadge status={run.status} />
              <styled.span fontSize="1" color="text.muted" flexShrink="0" w="5rem" textAlign="right">
                {formatAge(run.createdAt, now)}
              </styled.span>
            </HStack>
          </Link>
        </li>
      ))}
    </styled.ul>
  );
};

const HomeCollections = ({ now }: { now: number }) => {
  const [tab, setTab] = useState<HomeTab>('decide');
  const proposals = useProposals();
  const activity = useAuditEvents({ order: 'desc', limit: 10 });
  const runs = useRuns();
  const nowDate = useMemo(() => new Date(now), [now]);
  const titles = useMemo(
    () => new Map((proposals.data ?? []).map((p) => [p.id, p.title])),
    [proposals.data],
  );
  const pending = (proposals.data ?? []).filter((p) => p.status === 'pending_approval');

  return (
    <Flex direction="column" gap="5">
      <Flex justify="space-between" align="center" gap="3">
        <HStack gap="2" role="tablist" aria-label="Overview sections">
          <TabButton
            label="Needs your decision"
            count={proposals.data ? String(pending.length) : undefined}
            active={tab === 'decide'}
            select={() => setTab('decide')}
          />
          <TabButton
            label="Runs"
            count={runs.data ? String(runs.data.length) : undefined}
            active={tab === 'runs'}
            select={() => setTab('runs')}
          />
          <TabButton label="Activity" count={undefined} active={tab === 'activity'} select={() => setTab('activity')} />
        </HStack>
        <Link to={tab === 'decide' ? '/approvals' : tab === 'runs' ? '/runs' : '/audit'}>
          <styled.span fontSize="1.5" color="text.muted" _hover={{ color: 'text.app' }}>
            View all
          </styled.span>
        </Link>
      </Flex>
      {tab === 'decide' ? (
        proposals.isPending ? (
          <ProposalListSkeleton rows={3} />
        ) : proposals.isError ? (
          <ErrorState title="Could not load proposals" retry={() => void proposals.refetch()} />
        ) : pending.length === 0 ? (
          <EmptyState compact illustration="notification" title="You are all caught up" hint="New proposals that need a human land here." />
        ) : (
          <Flex direction="column" gap="1" data-testid="needs-decision">
            {pending.slice(0, 6).map((proposal) => (
              <ProposalRow key={proposal.id} proposal={proposal} now={now} compact />
            ))}
          </Flex>
        )
      ) : tab === 'runs' ? (
        <RunList now={now} />
      ) : activity.isPending ? (
        <ListSkeleton />
      ) : activity.isError ? (
        <styled.p color="text.muted">Could not load recent activity.</styled.p>
      ) : activity.data.length === 0 ? (
        <EmptyState compact illustration="reports" title="No activity yet" hint="Proposals, decisions and writes show here as they happen." />
      ) : (
        <Flex direction="column" gap="1" data-testid="recent-activity">
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
    </Flex>
  );
};

/** Overview: today's date, a greeting, the Copilot composer, the day's figures, then decisions, runs and activity. */
export const OverviewPage = () => {
  const me = useMe();
  const proposals = useProposals();
  const now = useNow(60_000);
  const navigate = useNavigate();
  const stats = useMemo(() => (proposals.data ? statsOf(proposals.data, now) : null), [proposals.data, now]);
  const firstName = me.data?.name.split(' ')[0];

  return (
    <Flex direction="column" h="full" minH="0" bg="background.app">
      <HStack
        h="2.75rem"
        flexShrink="0"
        borderBottomWidth="1px"
        borderColor="border.subtle"
        pl={{ base: '12', md: '5' }}
        pr="5"
        justify="space-between"
      >
        <styled.h1 fontSize="2" fontWeight="500">
          Overview
        </styled.h1>
        <StartRunButton size="xs" />
      </HStack>
      <Flex direction="column" flex="1" overflowY="auto" px={{ base: '4', md: '10' }} pb="12">
        <Flex direction="column" maxW="48rem" mx="auto" w="full" gap="10">
          <Flex direction="column" gap="8" pt={{ base: '10', md: '14' }}>
            <Box>
              <HStack
                gap="1.5"
                color="palette.orange.9"
                fontSize="1"
                fontWeight="500"
                letterSpacing="0.04em"
                mb="4"
                data-testid="home-date"
              >
                <styled.span w="1.5" h="1.5" rounded="full" bg="palette.orange.9" />
                {homeDate(new Date(now))}
              </HStack>
              <styled.h2
                fontSize={{ base: '5', md: '6' }}
                fontWeight="500"
                letterSpacing="-0.02em"
                lineHeight="1.3"
              >
                <styled.span display="block" color="text.muted">
                  Hey there{firstName ? `, ${firstName}` : ''}!
                </styled.span>
                <styled.span display="block" color="text.app" fontWeight="600">
                  {stats && stats.pending > 0
                    ? `${stats.pending} proposal${stats.pending === 1 ? '' : 's'} worth ${formatMoneyShort(stats.pendingValue)} need${stats.pending === 1 ? 's' : ''} a decision.`
                    : 'What should the agents look into?'}
                </styled.span>
              </styled.h2>
            </Box>
            <CopilotComposer
              busy={false}
              stop={null}
              send={(question) => void navigate({ to: '/copilot', search: { q: question } })}
              placeholder="Ask the Ops Lead about stock, vendors and orders"
            />
          </Flex>
          <Grid gridTemplateColumns={{ base: '1fr 1fr', md: 'repeat(4, minmax(0, 1fr))' }} gap="3">
            {stats === null ? (
              proposals.isError ? null : (
                [0, 1, 2, 3].map((key) => <Skeleton key={key} h="5.5rem" rounded="xl" />)
              )
            ) : (
              <>
                <Link to="/approvals" search={{ status: 'pending' }} data-stat-card="Pending approvals" className={css({ display: 'block', h: 'full', minW: '0' })}>
                  <StatCard
                    label="Pending approvals"
                    value={stats.pending}
                    note={
                      stats.oldestPending
                        ? `${stats.pendingHighRisk > 0 ? `${stats.pendingHighRisk} high risk · ` : ''}Oldest ${stats.oldestPending}`
                        : 'Inbox is clear'
                    }
                  />
                </Link>
                <StatCard
                  label="Auto-approved today"
                  value={stats.autoToday}
                  note={stats.autoToday > 0 ? `${formatMoneyShort(stats.autoTodayValue)} under the threshold` : 'Under the threshold'}
                />
                <StatCard
                  label="Executed today"
                  value={stats.executedToday}
                  tone={stats.failedToday > 0 ? 'bad' : undefined}
                  note={
                    stats.failedToday > 0
                      ? `${stats.failedToday} failed · ${stats.writesToday} write${stats.writesToday === 1 ? '' : 's'}`
                      : `${stats.writesToday} write${stats.writesToday === 1 ? '' : 's'} verified`
                  }
                />
                <StatCard
                  label="Proposed this week"
                  value={formatMoneyShort(stats.proposedWeek)}
                  note={`${formatMoneyShort(stats.approvedWeek)} approved`}
                />
              </>
            )}
          </Grid>
          <HomeCollections now={now} />
        </Flex>
      </Flex>
    </Flex>
  );
};
