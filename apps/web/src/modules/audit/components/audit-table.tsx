// Adapted from carbonme apps/admin/src/modules/customers/audit-table.tsx and audit-drawer.tsx, laid out as
// admin-app-mockup 10-audit-log: When / Who / "What and why" / Target · outcome, the row opening in place to the
// before → after values and its ids (event, idempotency key, record), as the mockup's .ba and .ameta blocks.
import { css, cx } from '@ops/ui/css';
import { Link } from '@tanstack/react-router';
import { Fragment, useState } from 'react';
import { Box, Flex, HStack, styled } from '@ops/ui/jsx';

import type {
  Actor,
  AuditEvent,
  PolicyReason,
  ProposalDetail,
} from '../../../api/generated/opsAgentAPI.schemas';
import { Icons } from '@ops/ui/icons/base';
import { tableStyles as t, WhenCell } from '../../system/components/admin-table';
import { Pill, TONES, type Tone } from '../../proposals/components/badges';
import { PolicyReasons } from '../../proposals/components/policy-panel';
import { ACTOR_KIND_LABELS, actorName } from '../../proposals/proposal-values';
import { useProposal } from '../../proposals/proposals-api';
import { auditValue, eventChanges, type AuditChange } from '../audit-changes';
import { auditDetail, auditVerb } from '../audit-values';

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

const isReason = (value: unknown): value is PolicyReason =>
  Boolean(value && typeof value === 'object' && 'rule' in value && 'message' in value && 'outcome' in value);

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

const mono = css({ fontFamily: 'mono', fontSize: '1' });

const MAX_LINES = 12;

/** Before and after side by side, the changed values tinted (the mockup's .ba). */
const BeforeAfter = ({ changes }: { changes: AuditChange[] }) => {
  const shown = changes.slice(0, MAX_LINES);
  const width = Math.min(28, Math.max(...shown.map((change) => change.field.length)));
  const side = (pick: 'before' | 'after') => (
    <Box
      bg="brand.panel.3"
      rounded="lg"
      px="2.5"
      py="2"
      fontFamily="mono"
      fontSize="0.719"
      lineHeight="1.6"
      color="text.label"
      whiteSpace="pre"
      overflowX="auto"
      minW="0"
      data-audit-side={pick}
    >
      {shown.map((change) => (
        <div key={change.field}>
          {change.field.padEnd(width).slice(0, width)}{' '}
          <styled.span
            color={pick === 'after' ? 'text.app' : undefined}
            bg={pick === 'after' ? 'palette.blue.4' : undefined}
            rounded="sm"
            px={pick === 'after' ? '0.5' : undefined}
          >
            {auditValue(change[pick])}
          </styled.span>
        </div>
      ))}
    </Box>
  );
  return (
    <Box mt="2.5">
      <Box display="grid" gridTemplateColumns="minmax(0, 1fr) 20px minmax(0, 1fr)" gap="2" alignItems="stretch">
        {side('before')}
        <Flex align="center" justify="center" color="text.placeholder">
          <Icons.caretRight size={12} />
        </Flex>
        {side('after')}
      </Box>
      {changes.length > MAX_LINES && (
        <styled.p fontSize="1" color="text.muted" mt="1">
          {changes.length - MAX_LINES} more changed fields on the proposal.
        </styled.p>
      )}
    </Box>
  );
};

const MetaChip = ({ icon, children }: { icon: keyof typeof Icons; children: React.ReactNode }) => {
  const Icon = Icons[icon];
  return (
    <HStack gap="1" color="text.muted" fontSize="0.719" whiteSpace="nowrap">
      <Icon size={11} />
      {children}
    </HStack>
  );
};

/** What an open row shows: the values before and after, the policy verdicts, and the ids (the mockup's .ameta). */
const OpenDetail = ({ event }: { event: AuditEvent }) =>
  event.proposalId ? (
    <OpenProposalDetail event={event} proposalId={event.proposalId} />
  ) : (
    <OpenDetailView event={event} proposal={undefined} loading={false} />
  );

const OpenProposalDetail = ({ event, proposalId }: { event: AuditEvent; proposalId: string }) => {
  const proposal = useProposal(proposalId);
  return <OpenDetailView event={event} proposal={proposal.data} loading={proposal.isPending} />;
};

const OpenDetailView = ({
  event,
  proposal,
  loading,
}: {
  event: AuditEvent;
  proposal: ProposalDetail | undefined;
  loading: boolean;
}) => {
  const op = event.opIndex !== null ? proposal?.ops.find((item) => item.index === event.opIndex) : undefined;
  const changes = eventChanges(event, op);
  const reasons = Array.isArray(event.data.reasons) ? event.data.reasons : null;
  const key = str(event.data.idempotencyKey) ?? op?.idempotencyKey ?? null;
  const record = str(event.data.recordId);
  return (
    <Box data-audit-open="">
      {changes.length > 0 ? (
        <BeforeAfter changes={changes} />
      ) : event.opIndex !== null && loading ? (
        <styled.p fontSize="1" color="text.muted" mt="2">
          Loading the op’s diff…
        </styled.p>
      ) : null}
      {event.type === 'policy.evaluated' && reasons && (
        <Box mt="2.5" p="1.5" rounded="lg" bg="brand.panel.3">
          <PolicyReasons reasons={reasons.filter(isReason)} />
        </Box>
      )}
      <HStack gap="3.5" mt="2" flexWrap="wrap">
        <MetaChip icon="hash">
          <span className={mono}>{event.id.slice(0, 8)}</span> · seq {event.seq}
        </MetaChip>
        {key && (
          <MetaChip icon="key">
            idem <span className={mono}>{key.length > 16 ? `${key.slice(0, 8)}…${key.slice(-4)}` : key}</span>
          </MetaChip>
        )}
        {record && (
          <MetaChip icon="database">
            record <span className={mono}>{record.length > 14 ? `${record.slice(0, 8)}…` : record}</span>
          </MetaChip>
        )}
        <MetaChip icon="user">
          {ACTOR_KIND_LABELS[event.actor.kind]} <span className={mono}>{event.actor.id.slice(0, 18)}</span>
        </MetaChip>
        {event.actor.scopes?.length ? <MetaChip icon="shieldCheck">{event.actor.scopes.join(' · ')}</MetaChip> : null}
      </HStack>
    </Box>
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

/** Harness events, newest first: when, who, what and why, and what it touched; a row opens in place. */
export const AuditTable = ({
  events,
  titles,
}: {
  events: AuditEvent[];
  titles: ReadonlyMap<string, string | null>;
}) => {
  // Like the mockup, the newest row with values to compare starts open.
  const [open, setOpen] = useState<string | null>(
    events.find((event) => event.opIndex !== null)?.id ?? events[0]?.id ?? null,
  );

  return (
    <div className={t.panel} data-testid="audit-table">
      <table className={cx(t.table, css({ minW: '52rem', fontSize: '1.5' }))}>
        <thead>
          <tr>
            <th className={cx(t.th, css({ w: '7rem' }))}>When</th>
            <th className={cx(t.th, css({ w: '11rem' }))}>Who</th>
            <th className={t.th}>What and why</th>
            <th className={cx(t.th, css({ w: '14rem' }))}>Target · outcome</th>
            <th className={cx(t.th, css({ w: '2.5rem' }))} aria-label="Open" />
          </tr>
        </thead>
        <tbody>
          {events.map((event) => {
            const isOpen = open === event.id;
            const outcome = outcomeOf(event);
            const title = event.proposalId ? (titles.get(event.proposalId) ?? null) : null;
            return (
              <Fragment key={event.id}>
                <tr
                  className={cx(
                    t.row,
                    css({ cursor: 'pointer', _hover: { bg: 'brand.panel.1' } }),
                    isOpen ? css({ bg: { base: 'brand.panel.1', _dark: 'brand.panel.2' } }) : undefined,
                  )}
                  data-audit-row={event.type}
                  aria-expanded={isOpen}
                  onClick={(click) => {
                    if (!(click.target as HTMLElement).closest('a')) setOpen(isOpen ? null : event.id);
                  }}
                >
                  <WhenCell at={event.at} />
                  <td className={t.tdTop}>
                    <HStack gap="2" alignItems="flex-start">
                      <Box mt="0.5">
                        <Avatar actor={event.actor} />
                      </Box>
                      <Flex direction="column" minW="0">
                        <styled.span truncate>{actorName(event.actor)}</styled.span>
                        <span className={t.muted}>{ACTOR_KIND_LABELS[event.actor.kind]}</span>
                      </Flex>
                    </HStack>
                  </td>
                  <td className={t.tdTop}>
                    <WhatAndWhy event={event} title={title} />
                    {isOpen && <OpenDetail event={event} />}
                  </td>
                  <td className={t.tdTop}>
                    <Flex direction="column" gap="1" alignItems="flex-start">
                      {event.proposalId ? (
                        <Link
                          to="/approvals/$proposalId"
                          params={{ proposalId: event.proposalId }}
                          className={css({ lineClamp: '2', _hover: { textDecoration: 'underline' } })}
                        >
                          {title ?? `Proposal ${event.proposalId.slice(0, 8)}`}
                          {event.opIndex !== null ? ` · op ${event.opIndex + 1}` : ''}
                        </Link>
                      ) : (
                        <span>Harness</span>
                      )}
                      <HStack gap="1" flexWrap="wrap">
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
                          whiteSpace="nowrap"
                        >
                          {actionCode(event)}
                        </styled.code>
                      </HStack>
                    </Flex>
                  </td>
                  <td className={t.tdTop}>
                    <styled.span color="text.muted" display="flex" mt="0.5">
                      {isOpen ? <Icons.caretUp size={12} /> : <Icons.caretDown size={12} />}
                    </styled.span>
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {events.length === 0 ? <p className={t.empty}>No events match these filters.</p> : null}
    </div>
  );
};
