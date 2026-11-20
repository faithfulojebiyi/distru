// Rows adapted from carbonme modules/layout/components/workspace-home.tsx (ChatList: a Link per row with an icon, a
// title, a status label and the time, separated by subtle borders), with a column header added for the run figures.
import { Link } from '@tanstack/react-router';
import { css } from '@ops/ui/css';
import { Box, Flex, styled } from '@ops/ui/jsx';

import type { RunSummary } from '../../api/generated/opsAgentAPI.schemas';
import { Icons } from '@ops/ui/icons/base';
import { Skeleton } from '@ops/ui/primitives/skeleton';
import { StatusBadge } from '../proposals/components/badges';
import { formatAge } from '../proposals/proposal-values';
import {
  durationText,
  formatCost,
  formatTokens,
} from '../steps/step-activity-data';
import { EmptyState, ErrorState } from '../system/components/states';
import { useNow } from '../system/use-now';
import { triggerOf } from './run-activity';
import { RunStatusBadge } from './run-badges';
import { LIVE_RUN_STATUSES, useRunLabel, useRuns } from './runs-api';
import { StartRunButton } from './start-run-dialog';

const COLUMNS =
  'minmax(0, 1.8fr) 8.5rem 6rem 5rem 7rem 4.5rem 4.5rem minmax(0, 1.4fr)';

const TRIGGER_ICONS = {
  manual: 'user',
  cron: 'calendarClock',
  webhook: 'zap',
  copilot: 'sparkle',
} as const;

const rowClass = css({
  display: { base: 'flex', lg: 'grid' },
  flexWrap: 'wrap',
  gridTemplateColumns: COLUMNS,
  alignItems: 'center',
  columnGap: '4',
  rowGap: '1.5',
  px: '3',
  py: '3',
  rounded: 'lg',
  borderBottomWidth: '1px',
  borderColor: 'border.subtle',
  fontSize: '1.5',
  _hover: { bg: 'background.muted' },
});

const Muted = ({ children, hideSmall = false }: { children: React.ReactNode; hideSmall?: boolean }) => (
  <styled.span
    fontSize="1"
    color="text.muted"
    fontVariantNumeric="tabular-nums"
    whiteSpace="nowrap"
    display={hideSmall ? { base: 'none', lg: 'inline' } : undefined}
  >
    {children}
  </styled.span>
);

const runDuration = (run: RunSummary, now: number) => {
  const end = LIVE_RUN_STATUSES.has(run.status) && run.status !== 'suspended' ? now : Date.parse(run.updatedAt);
  return durationText(end - Date.parse(run.createdAt));
};

const RunRow = ({ run, label, now }: { run: RunSummary; label: string; now: number }) => {
  const trigger = triggerOf(run.triggeredBy);
  const TriggerIcon = Icons[TRIGGER_ICONS[trigger.kind]];
  const { totals } = run;
  return (
    <li>
      <Link to="/runs/$runId" params={{ runId: run.runId }} className={rowClass} data-run-row={run.runId}>
        <Flex align="center" gap="3" minW="0" flex={{ base: '1 1 100%', lg: 'initial' }}>
          <TriggerIcon size={15} color="text.muted" flexShrink="0" />
          <Flex direction="column" minW="0">
            <styled.span truncate fontWeight="500" title={run.runId}>
              {label}
            </styled.span>
            <styled.span fontSize="1" color="text.muted" truncate>
              {trigger.label}
              {trigger.by ? ` · ${trigger.by}` : ''}
            </styled.span>
          </Flex>
        </Flex>
        <Box>
          <RunStatusBadge status={run.status} />
        </Box>
        <Muted>{formatAge(run.createdAt, now)}</Muted>
        <Muted>{runDuration(run, now)}</Muted>
        <Muted hideSmall>
          {totals ? `${totals.agentCalls} agents · ${totals.toolCalls} tools` : '—'}
        </Muted>
        <Muted hideSmall>{totals ? formatTokens(totals.tokens.total) : '—'}</Muted>
        <Muted hideSmall>{totals ? formatCost(totals.costUsd) : '—'}</Muted>
        <Flex align="center" gap="2" minW="0" flexWrap="wrap">
          {run.proposal ? (
            <>
              <StatusBadge status={run.proposal.status} />
              {run.proposal.totalValue !== null && (
                <Muted>
                  {run.proposal.totalValue.toLocaleString('en-US', {
                    style: 'currency',
                    currency: 'USD',
                    maximumFractionDigits: 0,
                  })}
                </Muted>
              )}
            </>
          ) : (
            <Muted>No proposal</Muted>
          )}
        </Flex>
      </Link>
    </li>
  );
};

const HEADERS = ['Run', 'Status', 'Started', 'Duration', 'Agents · tools', 'Tokens', 'Cost', 'Proposal'];

export const RunsList = () => {
  const runs = useRuns();
  const labelOf = useRunLabel();
  const now = useNow(5_000);

  if (runs.isPending)
    return (
      <Flex direction="column" gap="2" aria-hidden>
        {[0, 1, 2, 3].map((row) => (
          <Skeleton key={row} h="12" rounded="lg" />
        ))}
      </Flex>
    );

  if (runs.isError)
    return <ErrorState title="Could not load runs" retry={() => void runs.refetch()} />;

  if (!runs.data.length)
    return (
      <EmptyState
        illustration="task"
        title="No runs yet"
        hint="Start a restock run and its agents, tool calls and proposal show here step by step."
        action={<StartRunButton />}
      />
    );

  return (
    <Box maxW="80rem" mx="auto" w="full">
      <Box
        display={{ base: 'none', lg: 'grid' }}
        gridTemplateColumns={COLUMNS}
        columnGap="4"
        px="3"
        pb="2"
        fontSize="1"
        color="text.muted"
        borderBottomWidth="1px"
        borderColor="border.subtle"
      >
        {HEADERS.map((header) => (
          <span key={header}>{header}</span>
        ))}
      </Box>
      <styled.ul display="flex" flexDirection="column" data-testid="runs-list">
        {runs.data.map((run) => (
          <RunRow key={run.runId} run={run} label={labelOf(run)} now={now} />
        ))}
      </styled.ul>
    </Box>
  );
};
