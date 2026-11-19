import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo, type ReactNode } from 'react';
import { Box, Flex, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { Button } from '@ops/ui/primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@ops/ui/primitives/dropdown-menu';
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
  auditDays,
  auditDetail,
  auditTime,
  auditTypeOf,
  auditVerb,
} from '../audit-values';

export type AuditSearch = {
  type?: string;
  actor?: ActorKind;
  proposalId?: string;
};

const AUDIT_LIMIT = 500;

const FilterButton = ({
  label,
  value,
  icon,
  active,
  ...props
}: {
  label: string;
  value: string;
  icon?: ReactNode;
  active: boolean;
}) => (
  <Button
    {...props}
    variant="soft"
    size="sm"
    fontWeight="400"
    gap="1.5"
    data-audit-filter={label}
    data-active={active ? '' : undefined}
  >
    {icon}
    <Span color="text.muted">{label}</Span>
    <Span fontWeight={active ? '500' : '400'}>{value}</Span>
    <Icons.caretDown size={12} />
  </Button>
);

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

/** Every write and decision the harness recorded, newest first, filterable by event type and kind of actor. */
export const AuditLog = ({ search }: { search: AuditSearch }) => {
  const navigate = useNavigate();
  const events = useAuditEvents({
    order: 'desc',
    limit: AUDIT_LIMIT,
    ...(search.type ? { type: search.type } : {}),
    ...(search.proposalId ? { proposalId: search.proposalId } : {}),
  });
  const proposals = useProposals();
  const nowMs = useNow(30_000);
  const now = useMemo(() => new Date(nowMs), [nowMs]);

  const titles = useMemo(
    () => new Map((proposals.data ?? []).map((p) => [p.id, p.title])),
    [proposals.data],
  );

  const visible = (events.data ?? []).filter(
    (event) => !search.actor || event.actor.kind === search.actor,
  );

  const setSearch = (next: AuditSearch) =>
    void navigate({ to: '/audit', search: next });

  const filtered = Boolean(search.type || search.actor || search.proposalId);
  const proposalTitle = search.proposalId ? titles.get(search.proposalId) : null;

  return (
    <Flex direction="column" gap="3" maxW="64rem" mx="auto" w="full">
      <HStack gap="2" flexWrap="wrap">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <FilterButton
              label="Event"
              value={search.type ? auditTypeOf(search.type).label : 'Any'}
              active={Boolean(search.type)}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" w="16rem" maxH="22rem" overflowY="auto">
            <DropdownMenuItem onSelect={() => setSearch({ ...search, type: undefined })}>
              Any event
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {Object.entries(AUDIT_TYPES).map(([type, value]) => {
              const Icon = Icons[value.icon];
              return (
                <DropdownMenuItem key={type} onSelect={() => setSearch({ ...search, type })}>
                  <Icon size={13} />
                  {value.label}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <FilterButton
              label="Actor"
              icon={<Icons.user size={13} />}
              value={search.actor ? ACTOR_KIND_LABELS[search.actor] : 'Anyone'}
              active={Boolean(search.actor)}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" w="12rem">
            <DropdownMenuItem onSelect={() => setSearch({ ...search, actor: undefined })}>
              Anyone
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {(Object.keys(ACTOR_KIND_LABELS) as ActorKind[]).map((kind) => (
              <DropdownMenuItem key={kind} onSelect={() => setSearch({ ...search, actor: kind })}>
                {ACTOR_KIND_LABELS[kind]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {search.proposalId ? (
          <Button
            size="sm"
            variant="soft"
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
          <Button size="sm" variant="ghost" onClick={() => setSearch({})}>
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
      ) : visible.length === 0 ? (
        <EmptyState
          illustration="reports"
          title={filtered ? 'No events match these filters' : 'Nothing recorded yet'}
          hint={
            filtered
              ? 'Try another event type or actor.'
              : 'Every proposal, policy check, decision and write lands here as it happens.'
          }
        />
      ) : (
        <Flex direction="column" rounded="xl" bg="brand.panel.2" p="1.5" gap="1" data-testid="audit-log">
          {auditDays(visible, now).map((group) => (
            <Flex key={group.day} direction="column" gap="1">
              <styled.p px="2" pt="2" pb="1" fontSize="1" color="text.muted" fontWeight="500">
                {group.day}
              </styled.p>
              {group.events.map((event) => (
                <AuditRow
                  key={event.id}
                  event={event}
                  now={now}
                  title={event.proposalId ? (titles.get(event.proposalId) ?? null) : null}
                />
              ))}
            </Flex>
          ))}
        </Flex>
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
