// Adapted from carbonme apps/admin/src/modules/customers/audit-table.tsx, laid out as admin-app-mockup 10-audit-log:
// When / Who / "What and why" / Target · outcome, with the mockup's compact .ameta id chips under the sentence. As in
// carbonme's table, the whole row opens the full change in a drawer (./audit-drawer.tsx, from carbonme audit-drawer.tsx)
// rather than expanding in place, so long values are never squeezed into side-by-side panels.
import { css, cx } from '@ops/ui/css';
import { Link } from '@tanstack/react-router';
import { Box, Flex, HStack, styled } from '@ops/ui/jsx';

import type { Actor, AuditEvent } from '../../../api/generated/opsAgentAPI.schemas';
import { Icons } from '@ops/ui/icons/base';
import { Button } from '@ops/ui/primitives/button';
import { tableStyles as t, WhenCell } from '../../system/components/admin-table';
import { Pill, TONES, type Tone } from '../../proposals/components/badges';
import { ACTOR_KIND_LABELS, actorName } from '../../proposals/proposal-values';
import { auditDetail, auditTypeOf, auditVerb } from '../audit-values';

/** How an event ended, as the mockup's outcome badge. */
export const outcomeOf = (event: AuditEvent): { label: string; tone: Tone; key: AuditOutcome } => {
  switch (event.type) {
    case 'op.failed':
    case 'proposal.failed':
    case 'op.verify_failed':
    case 'budget.exceeded':
      return { label: 'Failed', tone: TONES.bad, key: 'failed' };
    case 'proposal.decision_blocked':
      return { label: 'Refused', tone: TONES.waiting, key: 'refused' };
    case 'op.retry':
      return { label: 'Retried', tone: TONES.waiting, key: 'refused' };
    case 'policy.evaluated':
      if (event.data.outcome === 'deny') return { label: 'Denied', tone: TONES.bad, key: 'refused' };
      if (event.data.outcome === 'needs_approval') return { label: 'Needs approval', tone: TONES.waiting, key: 'succeeded' };
      return { label: 'Allowed', tone: TONES.good, key: 'succeeded' };
    case 'proposal.decided':
      return event.data.decision === 'reject'
        ? { label: 'Rejected', tone: TONES.muted, key: 'succeeded' }
        : { label: 'Approved', tone: TONES.good, key: 'succeeded' };
    default:
      return { label: 'Succeeded', tone: TONES.good, key: 'succeeded' };
  }
};

export type AuditOutcome = 'succeeded' | 'refused' | 'failed';

const str = (value: unknown) => (typeof value === 'string' && value ? value : null);

/** The action code chip: the harness action for op events, the event type otherwise. */
const actionCode = (event: AuditEvent) => str(event.data.action) ?? event.type;

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((word) => word.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase();

const ACTOR_ICONS: Partial<Record<Actor['kind'], keyof typeof Icons>> = {
  agent: 'aiChip',
  system: 'gears',
  'mcp-client': 'code',
};

const Avatar = ({ actor }: { actor: Actor }) => {
  const icon = ACTOR_ICONS[actor.kind];
  const Icon = icon ? Icons[icon] : null;
  return (
    <Flex
      aria-hidden
      align="center"
      justify="center"
      w="5"
      h="5"
      rounded="full"
      flexShrink="0"
      bg={actor.kind === 'user' ? 'text.app' : 'brand.panel.5'}
      color={actor.kind === 'user' ? 'background.app' : 'text.muted'}
      fontSize="0.563rem"
      fontWeight="600"
    >
      {Icon ? <Icon size={11} /> : initials(actorName(actor))}
    </Flex>
  );
};

const mono = css({ fontFamily: 'mono', fontSize: '0.656rem' });

const MetaChip = ({ icon, children }: { icon: keyof typeof Icons; children: React.ReactNode }) => {
  const Icon = Icons[icon];
  return (
    <HStack gap="1" color="text.muted" fontSize="0.719rem" whiteSpace="nowrap">
      <Icon size={11} />
      {children}
    </HStack>
  );
};

const short = (value: string, keep = 8) => (value.length > keep + 4 ? `${value.slice(0, keep)}…` : value);

/** The mockup's .ameta line: event id · seq, idempotency key, record, shortened; the drawer has them in full. */
const IdChips = ({ event }: { event: AuditEvent }) => {
  const key = str(event.data.idempotencyKey);
  const record = str(event.data.recordId);
  return (
    <HStack gap="3.5" mt="1.5" flexWrap="wrap" data-audit-ids="">
      <MetaChip icon="hash">
        <span className={mono}>{event.id.slice(0, 8)}</span> · seq {event.seq}
      </MetaChip>
      {key ? (
        <MetaChip icon="key">
          idem <span className={mono}>{key.length > 16 ? `${key.slice(0, 8)}…${key.slice(-4)}` : key}</span>
        </MetaChip>
      ) : null}
      {record ? (
        <MetaChip icon="database">
          record <span className={mono}>{short(record, 10)}</span>
        </MetaChip>
      ) : null}
    </HStack>
  );
};

/** What happened and why, as one sentence and a quieter line (the mockup's "What and why"). */
const WhatAndWhy = ({ event, title }: { event: AuditEvent; title: string | null }) => {
  const detail = auditDetail(event);
  const bad = outcomeOf(event).key !== 'succeeded';
  return (
    <>
      <styled.p color="text.label" lineHeight="1.45">
        <styled.b color="text.app" fontWeight="500">
          {actorName(event.actor).split(' ')[0]}
        </styled.b>{' '}
        {auditVerb(event)}
        {event.opIndex !== null ? (
          <>
            {' '}
            <styled.b color="text.app" fontWeight="500">
              op {event.opIndex + 1}
            </styled.b>{' '}
            of the proposal
          </>
        ) : title && event.type === 'proposal.created' ? (
          <>
            {' '}
            <styled.b color="text.app" fontWeight="500">
              {title}
            </styled.b>
          </>
        ) : null}
      </styled.p>
      {detail && (
        <HStack gap="1.5" alignItems="flex-start" mt="1" color="text.muted" fontSize="1">
          <styled.span mt="0.5" flexShrink="0" display="flex">
            {bad ? <Icons.alertCircle size={11} /> : <Icons.messageSquare size={11} />}
          </styled.span>
          <span>{detail}</span>
        </HStack>
      )}
    </>
  );
};

/** Harness events, newest first: when, who, what and why, and what it touched; a row opens the event's drawer. */
export const AuditTable = ({
  events,
  titles,
  selected,
  onOpen,
}: {
  events: AuditEvent[];
  titles: ReadonlyMap<string, string | null>;
  selected: string | null;
  onOpen: (event: AuditEvent) => void;
}) => (
  <div className={t.panel} data-testid="audit-table">
    {/* minWidth inline: t.table's 48rem atomic class would otherwise win over an override class. */}
    <table className={cx(t.table, css({ fontSize: '1.5', tableLayout: 'fixed' }))} style={{ minWidth: '42rem' }}>
      <thead>
        <tr>
          <th className={cx(t.th, css({ w: '5.5rem' }))}>When</th>
          <th className={cx(t.th, css({ w: { base: '8.5rem', xl: '10.5rem' } }))}>Who</th>
          <th className={t.th}>What and why</th>
          <th className={cx(t.th, css({ w: { base: '11rem', xl: '13rem' } }))}>Target · outcome</th>
          <th className={cx(t.th, css({ w: { base: '3rem', xl: '7rem' } }))} aria-label="Details" />
        </tr>
      </thead>
      <tbody>
        {events.map((event) => {
          const isOpen = selected === event.id;
          const outcome = outcomeOf(event);
          const title = event.proposalId ? (titles.get(event.proposalId) ?? null) : null;
          return (
            <tr
              key={event.id}
              className={cx(
                t.row,
                css({ cursor: 'pointer', _hover: { bg: 'brand.panel.1' } }),
                isOpen ? css({ bg: { base: 'brand.panel.1', _dark: 'brand.panel.2' } }) : undefined,
              )}
              data-audit-row={event.type}
              data-audit-event-id={event.id}
              aria-selected={isOpen}
              onClick={(click) => {
                if (!(click.target as HTMLElement).closest('a, button')) onOpen(event);
              }}
            >
              <WhenCell at={event.at} />
              <td className={t.tdTop}>
                <HStack gap="2" alignItems="flex-start" minW="0">
                  <Box mt="0.5">
                    <Avatar actor={event.actor} />
                  </Box>
                  <Flex direction="column" minW="0">
                    <styled.span truncate>{actorName(event.actor)}</styled.span>
                    <span className={t.muted}>{ACTOR_KIND_LABELS[event.actor.kind]}</span>
                  </Flex>
                </HStack>
              </td>
              <td className={cx(t.tdTop, css({ minW: '0', overflowWrap: 'anywhere' }))}>
                <WhatAndWhy event={event} title={title} />
                <IdChips event={event} />
              </td>
              <td className={t.tdTop}>
                <Flex direction="column" gap="1" alignItems="flex-start" minW="0">
                  {event.proposalId ? (
                    <Link
                      to="/approvals/$proposalId"
                      params={{ proposalId: event.proposalId }}
                      className={css({ lineClamp: '2', overflowWrap: 'anywhere', _hover: { textDecoration: 'underline' } })}
                    >
                      {title ?? `Proposal ${event.proposalId.slice(0, 8)}`}
                      {event.opIndex !== null ? ` · op ${event.opIndex + 1}` : ''}
                    </Link>
                  ) : (
                    <span>Harness</span>
                  )}
                  <HStack gap="1" flexWrap="wrap" minW="0">
                    <Pill tone={outcome.tone} label={outcome.label} data-audit-outcome={outcome.key} />
                    <styled.code
                      fontFamily="mono"
                      fontSize="0.656rem"
                      px="1.5"
                      h="18px"
                      display="inline-flex"
                      alignItems="center"
                      rounded="md"
                      bg="brand.panel.5"
                      color="text.label"
                      maxW="full"
                      overflow="hidden"
                      textOverflow="ellipsis"
                      whiteSpace="nowrap"
                      title={actionCode(event)}
                    >
                      {actionCode(event)}
                    </styled.code>
                  </HStack>
                </Flex>
              </td>
              <td className={cx(t.tdTop, css({ textAlign: 'right' }))}>
                <Button
                  variant="ghost"
                  size="xs"
                  color="text.muted"
                  fontWeight="400"
                  _hover={{ color: 'text.app' }}
                  title="View details"
                  aria-label={`View details of ${auditTypeOf(event.type).label.toLowerCase()} event`}
                  onClick={() => onOpen(event)}
                  data-audit-view=""
                >
                  <styled.div display={{ base: 'none', xl: 'block' }}>View details</styled.div>
                  <Icons.caretRight size={11} />
                </Button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
    {events.length === 0 ? <p className={t.empty}>No events match these filters.</p> : null}
  </div>
);
