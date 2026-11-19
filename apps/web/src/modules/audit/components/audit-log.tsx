// The log page: filter pills (carbonme activity-settings FilterButton) over carbonme admin audit-table.tsx (audit-table.tsx
// here) and admin ui/pager.tsx. AuditRow stays the compact row the Overview's Activity tab uses.
import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Box, Flex, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { Button } from '@ops/ui/primitives/button';
import { Skeleton } from '@ops/ui/primitives/skeleton';
import { Span } from '@ops/ui/primitives/text';
import type {
  ActorKind,
  AuditEvent,
} from '../../../api/generated/opsAgentAPI.schemas';
import { useNow } from '../../system/use-now';
import { EmptyState, ErrorState } from '../../system/components/states';
import { ACTOR_KIND_LABELS, actorName } from '../../proposals/proposal-values';
import { useAuditEvents, useProposals } from '../../proposals/proposals-api';
import {
  AUDIT_TYPES,
  auditDetail,
  auditTime,
  auditTypeOf,
  auditVerb,
} from '../audit-values';
import {
  DATE_RANGES,
  FilterChip,
  inRange,
  type DateRange,
} from '../../system/components/filter-chip';
import { Pager } from '../../system/components/pager';
import { AuditTable, outcomeOf, type AuditOutcome } from './audit-table';

export type AuditSearch = {
  type?: string;
  actor?: ActorKind;
  proposalId?: string;
  outcome?: AuditOutcome;
  range?: DateRange;
};

const AUDIT_LIMIT = 500;

/** One event: its marker, who did what to which proposal, a line of detail and the time (carbonme ActivityRow). */
const AuditRow = ({
  event,
  title,
  now,
}: {
  event: AuditEvent;
  title: string | null;
  now: Date;
}) => {
  const type = auditTypeOf(event.type);
  const Icon = Icons[type.icon];
  const detail = auditDetail(event);
  const body = (
    <HStack
      gap="3"
      px="3"
      py="2.5"
      rounded="lg"
      bg="background.app"
      fontSize="1.5"
      transition="background 0.12s"
      _hover={event.proposalId ? { bg: { base: 'brand.panel.3', _dark: 'brand.panel.4' } } : undefined}
      data-audit-row={event.type}
    >
      <Flex
        align="center"
        justify="center"
        w="7"
        h="7"
        rounded="full"
        flexShrink="0"
        className={type.tone.className}
        title={type.label}
      >
        <Icon size={13} />
      </Flex>
      <Flex direction="column" flex="1" minW="0" gap="0.5">
        <styled.p truncate>
          <Span fontWeight="500">{actorName(event.actor)}</Span> {auditVerb(event)}
          {title ? (
            <>
              {' '}
              <Span color="text.muted">on</Span> <Span fontWeight="500">{title}</Span>
            </>
          ) : null}
        </styled.p>
        <Span color="text.muted" fontSize="1" truncate>
          {[type.label, detail].filter(Boolean).join(' · ')}
        </Span>
      </Flex>
      <Span color="text.muted" fontSize="1" flexShrink="0" fontVariantNumeric="tabular-nums">
        {auditTime(event.at, now)}
      </Span>
    </HStack>
  );
  return event.proposalId ? (
    <Link to="/approvals/$proposalId" params={{ proposalId: event.proposalId }}>
      {body}
    </Link>
  ) : (
    body
  );
};

const AuditSkeleton = () => (
  <Flex direction="column" gap="1" p="1.5" rounded="xl" bg="brand.panel.2" aria-busy="true">
    {Array.from({ length: 8 }, (_, index) => (
      <HStack key={index} gap="3" px="3" py="2.5" rounded="lg" bg="background.app">
        <Skeleton w="7" h="7" rounded="full" />
        <Flex direction="column" gap="1.5" flex="1">
          <Skeleton h="3" w="50%" rounded="md" />
          <Skeleton h="2.5" w="30%" rounded="md" />
        </Flex>
      </HStack>
    ))}
  </Flex>
);

const PAGE_SIZE = 25;

const OUTCOMES = [
  { value: 'succeeded', label: 'Succeeded' },
  { value: 'refused', label: 'Refused or denied' },
  { value: 'failed', label: 'Failed' },
] as const satisfies readonly { value: AuditOutcome; label: string }[];

const ACTORS = (Object.keys(ACTOR_KIND_LABELS) as ActorKind[]).map((kind) => ({
  value: kind,
  label: ACTOR_KIND_LABELS[kind],
}));

const EVENT_TYPES = Object.entries(AUDIT_TYPES).map(([value, type]) => ({ value, label: type.label }));

/** Every write and decision the harness recorded, newest first, as admin-app-mockup 10: filter pills over a table
 * whose rows open to the values before and after. */
export const AuditLog = ({ search }: { search: AuditSearch }) => {
  const navigate = useNavigate();
  const events = useAuditEvents({
    order: 'desc',
    limit: AUDIT_LIMIT,
    ...(search.type ? { type: search.type } : {}),
    ...(search.proposalId ? { proposalId: search.proposalId } : {}),
  });
  const proposals = useProposals();
  const now = useNow(30_000);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const range = search.range ?? '7d';

  const titles = useMemo(
    () => new Map((proposals.data ?? []).map((p) => [p.id, p.title])),
    [proposals.data],
  );

  const visible = (events.data ?? []).filter(
    (event) =>
      (!search.actor || event.actor.kind === search.actor) &&
      (!search.outcome || outcomeOf(event).key === search.outcome) &&
      inRange(event.at, range, now),
  );
  const offset = Number(cursor ?? 0);
  const page = visible.slice(offset, offset + PAGE_SIZE);

  const setSearch = (next: AuditSearch) => {
    setCursor(undefined);
    void navigate({ to: '/audit', search: next });
  };

  const filtered = Boolean(search.type || search.actor || search.proposalId || search.outcome || search.range);
  const proposalTitle = search.proposalId ? titles.get(search.proposalId) : null;

  return (
    <Flex direction="column" gap="4" maxW="70rem" mx="auto" w="full">
      <HStack gap="2" flexWrap="wrap">
        <FilterChip
          icon={<Icons.user size={13} />}
          anyLabel="Anyone"
          value={search.actor ?? null}
          options={ACTORS}
          onChange={(actor) => setSearch({ ...search, actor: actor ?? undefined })}
        />
        <FilterChip
          label="Event"
          value={search.type ?? null}
          options={EVENT_TYPES}
          onChange={(type) => setSearch({ ...search, type: type ?? undefined })}
        />
        <FilterChip
          label="Outcome"
          value={search.outcome ?? null}
          options={OUTCOMES}
          onChange={(outcome) => setSearch({ ...search, outcome: outcome ?? undefined })}
        />
        <FilterChip
          icon={<Icons.calendar size={13} />}
          anyLabel={null}
          value={range}
          options={DATE_RANGES}
          onChange={(next) => setSearch({ ...search, range: next && next !== '7d' ? next : undefined })}
        />
        {search.proposalId ? (
          <Button
            size="sm"
            variant="soft"
            fontSize="1"
            fontWeight="400"
            gap="1.5"
            onClick={() => setSearch({ ...search, proposalId: undefined })}
            aria-label="Clear proposal filter"
          >
            <Span color="text.muted">Proposal</Span>
            <Span fontWeight="500" maxW="16rem" truncate>
              {proposalTitle ?? search.proposalId.slice(0, 8)}
            </Span>
            <Icons.close size={12} />
          </Button>
        ) : null}
        {filtered ? (
          <Button size="sm" variant="ghost" fontSize="1" onClick={() => setSearch({})}>
            Clear filters
          </Button>
        ) : null}
        <Span ml="auto" color="text.muted" fontSize="1">
          {events.data ? `${visible.length} event${visible.length === 1 ? '' : 's'}` : ''}
        </Span>
      </HStack>

      {events.isPending ? (
        <AuditSkeleton />
      ) : events.isError ? (
        <ErrorState title="Could not load the audit log" retry={() => void events.refetch()} />
      ) : visible.length === 0 && !filtered ? (
        <EmptyState
          illustration="reports"
          title="Nothing recorded in this window"
          hint="Every proposal, policy check, decision and write lands here as it happens. Try a longer date range."
        />
      ) : (
        <>
          <AuditTable key={`${offset}:${page[0]?.id ?? ''}`} events={page} titles={titles} />
          {visible.length > PAGE_SIZE && (
            <Pager
              cursor={cursor}
              nextCursor={offset + PAGE_SIZE < visible.length ? String(offset + PAGE_SIZE) : null}
              onPage={setCursor}
            />
          )}
        </>
      )}
      {events.data && events.data.length >= AUDIT_LIMIT ? (
        <Box textAlign="center">
          <Span color="text.muted" fontSize="1">
            Showing the newest {AUDIT_LIMIT} events.
          </Span>
        </Box>
      ) : null}
    </Flex>
  );
};

export { AuditRow };
