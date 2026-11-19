import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo } from 'react';
import { css } from '@ops/ui/css';
import { Box, Flex, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { Skeleton } from '@ops/ui/primitives/skeleton';
import { Tabs, TabsList, TabTrigger } from '@ops/ui/primitives/tabs';
import { Span } from '@ops/ui/primitives/text';
import type {
  Principal,
  ProposalSummary,
} from '../../../api/generated/opsAgentAPI.schemas';
import { useNow } from '../../system/use-now';
import { EmptyState, ErrorState } from '../../system/components/states';
import {
  INBOX_TABS,
  actorName,
  formatAge,
  formatMoney,
  inTab,
  opsSummary,
  type InboxTab,
} from '../proposal-values';
import { useProposals } from '../proposals-api';
import { PolicyBadge, StatusBadge } from './badges';

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

const RowTitle = ({ proposal }: { proposal: ProposalSummary }) => (
  <Flex direction="column" gap="0.5" minW="0">
    <Span fontWeight="500" fontSize="1.5" truncate>
      {proposal.title ?? 'Untitled proposal'}
    </Span>
    <HStack gap="2.5" minW="0" fontSize="1" color="text.muted">
      <Span truncate flexShrink="1">
        {opsSummary(proposal)}
      </Span>
      <Box w="1px" h="3" bg="border.subtle" flexShrink="0" />
      <CreatedBy principal={proposal.createdBy} />
    </HStack>
  </Flex>
);

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

const ColumnHeads = () => (
  <styled.div
    hideBelow="lg"
    display="grid"
    gridTemplateColumns="minmax(0, 1fr) 7.5rem 11rem 11rem"
    columnGap="4"
    px="3"
    pt="1"
    pb="0.5"
    fontSize="1"
    color="text.muted"
  >
    <span>Proposal</span>
    <styled.span textAlign="right">Total</styled.span>
    <span>Policy</span>
    <styled.span textAlign="right">Status</styled.span>
  </styled.div>
);

/** The approvals inbox: status tabs with live counts over one list of proposals. */
export const ProposalInbox = ({ tab }: { tab: InboxTab }) => {
  const proposals = useProposals();
  const navigate = useNavigate();
  const now = useNow(30_000);

  const counts = useMemo(() => {
    const items = proposals.data ?? [];
    return Object.fromEntries(
      INBOX_TABS.map((item) => [
        item.key,
        items.filter((proposal) => inTab(item.key, proposal.status)).length,
      ]),
    ) as Record<InboxTab, number>;
  }, [proposals.data]);

  const visible = (proposals.data ?? []).filter((proposal) =>
    inTab(tab, proposal.status),
  );

  return (
    <Flex direction="column" gap="4">
      <Tabs
        value={tab}
        onValueChange={(value) =>
          void navigate({ to: '/approvals', search: { status: value as InboxTab } })
        }
      >
        <Box overflowX="auto" mx="-1" px="1" pb="0.5">
          <TabsList>
            {INBOX_TABS.map((item) => (
              <TabTrigger key={item.key} value={item.key} gap="1.5" data-inbox-tab={item.key}>
                {item.label}
                {proposals.data ? (
                  <styled.span
                    fontSize="1"
                    fontVariantNumeric="tabular-nums"
                    px="1.5"
                    rounded="full"
                    minW="5"
                    textAlign="center"
                    bg={
                      item.key === 'pending' && counts.pending > 0
                        ? 'palette.amber.9'
                        : 'brand.panel.6'
                    }
                    color={
                      item.key === 'pending' && counts.pending > 0
                        ? 'white'
                        : 'text.muted'
                    }
                  >
                    {counts[item.key]}
                  </styled.span>
                ) : null}
              </TabTrigger>
            ))}
          </TabsList>
        </Box>
      </Tabs>

      {proposals.isPending ? (
        <ProposalListSkeleton />
      ) : proposals.isError ? (
        <ErrorState
          title="Could not load proposals"
          retry={() => void proposals.refetch()}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          illustration={tab === 'pending' ? 'notification' : 'lists'}
          title={EMPTY[tab].title}
          hint={EMPTY[tab].hint}
        />
      ) : (
        <Flex direction="column" gap="1" p="1.5" rounded="xl" bg="brand.panel.2" data-testid="proposal-list">
          <ColumnHeads />
          {visible.map((proposal) => (
            <ProposalRow key={proposal.id} proposal={proposal} now={now} />
          ))}
        </Flex>
      )}
    </Flex>
  );
};
