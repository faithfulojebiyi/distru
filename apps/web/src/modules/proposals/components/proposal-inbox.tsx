// The inbox is adapted from carbonme apps/admin/src/modules/customers/customers-page.tsx (search + filters over a
// table) and ui/table.tsx, as admin-app-mockup 02-customers; ProposalRow stays the Overview's compact row.
import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { css, cx } from '@ops/ui/css';
import { Box, Flex, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { Skeleton } from '@ops/ui/primitives/skeleton';
import { Button } from '@ops/ui/primitives/button';
import { Input } from '@ops/ui/primitives/input';
import { Span } from '@ops/ui/primitives/text';
import type {
  Principal,
  ProposalStatus,
  ProposalSummary,
  Risk,
} from '../../../api/generated/opsAgentAPI.schemas';
import { lineTableStyles as t } from '../../system/components/admin-table';
import {
  DATE_RANGES,
  FilterChip,
  inRange,
  type DateRange,
} from '../../system/components/filter-chip';
import { useNow } from '../../system/use-now';
import { EmptyState, ErrorState } from '../../system/components/states';
import {
  INBOX_TABS,
  STATUS_LABELS,
  actorName,
  formatAge,
  formatMoney,
  inTab,
  opsSummary,
  type InboxTab,
} from '../proposal-values';
import { useProposals } from '../proposals-api';
import { titleParts } from '../proposal-record';
import { PolicyBadge, RiskBadge, StatusBadge } from './badges';

const KIND_ICONS: Record<Principal['kind'], keyof typeof Icons> = {
  agent: 'aiChip',
  user: 'user',
  'mcp-client': 'code',
};

/** Who proposed it: an agent, a person, or an MCP client such as Claude Code. */
export const CreatedBy = ({ principal }: { principal: Principal }) => {
  const Icon = Icons[KIND_ICONS[principal.kind]];
  return (
    <HStack gap="1.5" minW="0" color="text.muted" fontSize="1">
      <Icon size={12} flexShrink="0" />
      <Span truncate>{actorName(principal)}</Span>
    </HStack>
  );
};

const EMPTY: Record<InboxTab, { title: string; hint: string }> = {
  pending: {
    title: 'Nothing waiting for a decision',
    hint: 'When an agent proposes a write that policy will not auto-approve, it lands here.',
  },
  auto: {
    title: 'No auto-approved proposals',
    hint: 'Small, low-risk changes under the auto-approve threshold skip the queue and show here.',
  },
  executed: {
    title: 'Nothing executed yet',
    hint: 'Approved proposals appear here once the executor writes them to Distru.',
  },
  closed: {
    title: 'No rejected or failed proposals',
    hint: 'Proposals that were rejected, denied by policy or failed while writing show here.',
  },
  all: {
    title: 'No proposals yet',
    hint: 'Start a restock run, or ask the Copilot, and the agents will propose changes here.',
  },
};

const RowTitle = ({ proposal }: { proposal: ProposalSummary }) => {
  const { title, summary } = titleParts(proposal);
  return (
  <Flex direction="column" gap="0.5" minW="0">
    <Span fontWeight="500" fontSize="1.5" truncate title={proposal.title ?? undefined}>
      {title}
    </Span>
    <HStack gap="2.5" minW="0" fontSize="1" color="text.muted">
      <Span truncate flexShrink="1" title={summary ?? undefined}>
        {summary ?? opsSummary(proposal)}
      </Span>
      <Box w="1px" h="3" bg="border.subtle" flexShrink="0" />
      <CreatedBy principal={proposal.createdBy} />
    </HStack>
  </Flex>
  );
};

const rowClass = css({
  alignItems: 'center',
  columnGap: '4',
  rowGap: '1.5',
  px: '3',
  py: '2.5',
  rounded: 'lg',
  bg: 'background.app',
  transition: 'background 0.12s',
  _hover: { bg: { base: 'brand.panel.3', _dark: 'brand.panel.4' } },
});

/** One proposal in the inbox: what it changes and who proposed it, its value, policy, status and age. */
export const ProposalRow = ({
  proposal,
  now,
  compact = false,
}: {
  proposal: ProposalSummary;
  now: number;
  /** The overview's short list: title, total and age only. */
  compact?: boolean;
}) => (
  <Link
    to="/approvals/$proposalId"
    params={{ proposalId: proposal.id }}
    data-proposal-row={proposal.id}
  >
    {compact ? (
      <styled.div display="grid" gridTemplateColumns="minmax(0, 1fr) auto" className={rowClass}>
        <RowTitle proposal={proposal} />
        <Flex direction="column" align="flex-end" gap="0.5">
          <Span fontWeight="500" fontSize="1.5" fontVariantNumeric="tabular-nums">
            {formatMoney(proposal.totalValue)}
          </Span>
          <Span color="text.muted" fontSize="1" whiteSpace="nowrap">
            {formatAge(proposal.createdAt, now)}
          </Span>
        </Flex>
      </styled.div>
    ) : (
      <styled.div
        display="grid"
        gridTemplateColumns={{
          base: 'minmax(0, 1fr) auto',
          lg: 'minmax(0, 1fr) 7.5rem 11rem 11rem',
        }}
        className={rowClass}
      >
        <RowTitle proposal={proposal} />
        <Span
          hideBelow="lg"
          textAlign="right"
          fontWeight="500"
          fontSize="1.5"
          fontVariantNumeric="tabular-nums"
        >
          {formatMoney(proposal.totalValue)}
        </Span>
        <Box hideBelow="lg">
          <PolicyBadge outcome={proposal.policyOutcome} />
        </Box>
        <Flex
          direction={{ base: 'column', lg: 'row' }}
          align={{ base: 'flex-end', lg: 'center' }}
          justify="flex-end"
          gap={{ base: '1', lg: '3' }}
        >
          <StatusBadge status={proposal.status} />
          <Span color="text.muted" fontSize="1" whiteSpace="nowrap" fontVariantNumeric="tabular-nums">
            <Span hideFrom="lg">{formatMoney(proposal.totalValue)} · </Span>
            {formatAge(proposal.createdAt, now)}
          </Span>
        </Flex>
      </styled.div>
    )}
  </Link>
);

export const ProposalListSkeleton = ({ rows = 5 }: { rows?: number }) => (
  <Flex direction="column" gap="1" p="1.5" rounded="xl" bg="brand.panel.2" aria-busy="true">
    {Array.from({ length: rows }, (_, index) => (
      <HStack key={index} gap="4" px="3" py="3" rounded="lg" bg="background.app">
        <Flex direction="column" gap="1.5" flex="1">
          <Skeleton h="3.5" w="55%" rounded="md" />
          <Skeleton h="2.5" w="35%" rounded="md" />
        </Flex>
        <Skeleton h="5" w="24" rounded="full" />
      </HStack>
    ))}
  </Flex>
);

type InboxFilters = {
  q: string;
  status: ProposalStatus | null;
  risk: Risk | null;
  createdBy: string | null;
  range: DateRange;
};

/** A status tab as the mockup's segmented counts: "All 214  Needs attention 7". */
const SegTab = ({
  label,
  count,
  active,
  urgent,
  select,
}: {
  label: string;
  count: number | undefined;
  active: boolean;
  urgent: boolean;
  select: () => void;
}) => (
  <styled.button
    type="button"
    role="tab"
    aria-selected={active}
    onClick={select}
    display="inline-flex"
    alignItems="center"
    gap="1.5"
    h="7"
    px="2.5"
    rounded="md"
    fontSize="1.5"
    whiteSpace="nowrap"
    cursor="pointer"
    bg={active ? 'brand.panel.4' : 'transparent'}
    color={active ? 'text.app' : 'text.label'}
    fontWeight={active ? '500' : '400'}
    _hover={{ bg: active ? 'brand.panel.4' : 'brand.panel.3' }}
    data-inbox-tab={label}
  >
    {label}
    {count !== undefined && (
      <styled.span color={urgent ? 'palette.amber.11' : 'text.muted'} fontVariantNumeric="tabular-nums">
        {count}
      </styled.span>
    )}
  </styled.button>
);

const STATUS_OPTIONS = (Object.keys(STATUS_LABELS) as ProposalStatus[]).map((status) => ({
  value: status,
  label: STATUS_LABELS[status],
}));

const RISK_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
] as const satisfies readonly { value: Risk; label: string }[];

/** The approvals inbox, as admin-app-mockup 02-customers: status tabs with counts, a search and filter pills, then
 * one hairline table (carbonme admin customers-page.tsx filters, dashboard list rows). */
export const ProposalInbox = ({ tab }: { tab: InboxTab }) => {
  const proposals = useProposals();
  const navigate = useNavigate();
  const now = useNow(30_000);
  const [filters, setFilters] = useState<InboxFilters>({
    q: '',
    status: null,
    risk: null,
    createdBy: null,
    range: 'all',
  });

  const counts = useMemo(() => {
    const items = proposals.data ?? [];
    return Object.fromEntries(
      INBOX_TABS.map((item) => [
        item.key,
        items.filter((proposal) => inTab(item.key, proposal.status)).length,
      ]),
    ) as Record<InboxTab, number>;
  }, [proposals.data]);

  const creators = useMemo(
    () =>
      [...new Set((proposals.data ?? []).map((proposal) => actorName(proposal.createdBy)))]
        .sort()
        .map((name) => ({ value: name, label: name })),
    [proposals.data],
  );

  const term = filters.q.trim().toLowerCase();
  const visible = (proposals.data ?? []).filter(
    (proposal) =>
      inTab(tab, proposal.status) &&
      (!term || (proposal.title ?? '').toLowerCase().includes(term) || proposal.id.startsWith(term)) &&
      (!filters.status || proposal.status === filters.status) &&
      (!filters.risk || proposal.maxRisk === filters.risk) &&
      (!filters.createdBy || actorName(proposal.createdBy) === filters.createdBy) &&
      inRange(proposal.createdAt, filters.range, now),
  );
  const filtered = Boolean(term || filters.status || filters.risk || filters.createdBy || filters.range !== 'all');

  return (
    <Flex direction="column" gap="4" maxW="80rem" mx="auto" w="full">
      <HStack gap="1" role="tablist" aria-label="Proposal status" overflowX="auto" pb="0.5">
        {INBOX_TABS.map((item) => (
          <SegTab
            key={item.key}
            label={item.label}
            count={proposals.data ? counts[item.key] : undefined}
            active={tab === item.key}
            urgent={item.key === 'pending' && counts.pending > 0}
            select={() => void navigate({ to: '/approvals', search: { status: item.key } })}
          />
        ))}
      </HStack>
      <HStack gap="2" flexWrap="wrap">
        <Box pos="relative" w={{ base: 'full', md: '18rem' }}>
          <styled.span
            pos="absolute"
            left="2.5"
            top="50%"
            transform="translateY(-50%)"
            color="text.muted"
            display="flex"
            pointerEvents="none"
          >
            <Icons.searchNormal size={14} />
          </styled.span>
          <Input
            aria-label="Search proposals"
            placeholder="Search title or id"
            value={filters.q}
            onChange={(event) => setFilters({ ...filters, q: event.target.value })}
            size="sm"
            pl="8"
          />
        </Box>
        <FilterChip
          label="Status"
          value={filters.status}
          options={STATUS_OPTIONS}
          onChange={(status) => setFilters({ ...filters, status })}
        />
        <FilterChip
          label="Risk"
          value={filters.risk}
          options={RISK_OPTIONS}
          onChange={(risk) => setFilters({ ...filters, risk })}
        />
        <FilterChip
          label="Created by"
          value={filters.createdBy}
          options={creators}
          onChange={(createdBy) => setFilters({ ...filters, createdBy })}
        />
        <FilterChip
          icon={<Icons.calendar size={13} />}
          anyLabel={null}
          value={filters.range}
          options={DATE_RANGES}
          onChange={(range) => setFilters({ ...filters, range: range ?? 'all' })}
        />
        {filtered && (
          <Button
            size="sm"
            variant="ghost"
            fontSize="1"
            onClick={() => setFilters({ q: '', status: null, risk: null, createdBy: null, range: 'all' })}
          >
            Clear filters
          </Button>
        )}
      </HStack>

      {proposals.isPending ? (
        <ProposalListSkeleton />
      ) : proposals.isError ? (
        <ErrorState title="Could not load proposals" retry={() => void proposals.refetch()} />
      ) : visible.length === 0 && !filtered ? (
        <EmptyState
          illustration={tab === 'pending' ? 'notification' : 'lists'}
          title={EMPTY[tab].title}
          hint={EMPTY[tab].hint}
        />
      ) : (
        <div className={t.panel} data-testid="proposal-list">
          <table className={t.table}>
            <thead>
              <tr>
                <th className={t.th}>Proposal</th>
                <th className={t.th}>Created by</th>
                <th className={t.th}>Policy</th>
                <th className={t.th}>Risk</th>
                <th className={t.thNumber}>Total</th>
                <th className={t.th}>Status</th>
                <th className={t.thNumber}>Proposed</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((proposal) => {
                const risk = proposal.maxRisk;
                return (
                  <tr
                    key={proposal.id}
                    className={cx(t.row, css({ cursor: 'pointer' }))}
                    data-proposal-row={proposal.id}
                    onClick={() => void navigate({ to: '/approvals/$proposalId', params: { proposalId: proposal.id } })}
                  >
                    <td className={t.td}>
                      <Link
                        to="/approvals/$proposalId"
                        params={{ proposalId: proposal.id }}
                        className={css({ fontWeight: '500', lineClamp: '1', maxW: '28rem' })}
                      >
                        {proposal.title ?? 'Untitled proposal'}
                      </Link>
                      <div className={t.muted}>{opsSummary(proposal)}</div>
                    </td>
                    <td className={t.td}>
                      <CreatedBy principal={proposal.createdBy} />
                    </td>
                    <td className={t.td}>
                      <PolicyBadge outcome={proposal.policyOutcome} />
                    </td>
                    <td className={t.td}>{risk ? <RiskBadge risk={risk} /> : <span className={t.muted}>–</span>}</td>
                    <td className={t.tdNumber}>{formatMoney(proposal.totalValue)}</td>
                    <td className={t.td}>
                      <StatusBadge status={proposal.status} />
                    </td>
                    <td className={cx(t.tdNumber, t.muted)}>{formatAge(proposal.createdAt, now)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {visible.length === 0 ? <p className={t.empty}>No proposals match these filters.</p> : null}
        </div>
      )}
    </Flex>
  );
};
