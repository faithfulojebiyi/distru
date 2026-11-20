// Adapted from carbonme apps/admin/src/modules/customers/audit-drawer.tsx (one change in full: a facts grid, the
// Changes table of field | before | after on a grey panel with white rows, the raw JSON underneath), in carbonme's
// SideDrawer (apps/admin/src/ui/side-drawer.tsx → ../../system/components/side-drawer). Ops Agent additions: the
// row's sentence as the title, outcome pill + action code, unchanged fields collapsed under the diff, op references
// shown with what they resolved to, policy verdicts, expected vs actual for failed verifies, copyable id chips, and
// prev/next stepping (↑/↓) between events.
import { css, cx } from '@ops/ui/css';
import { Link } from '@tanstack/react-router';
import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Box, Flex, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { Button } from '@ops/ui/primitives/button';
import { Kbd } from '@ops/ui/primitives/kbd';
import { toast } from '@ops/ui/primitives/toast/toast';
import type {
  AuditEvent,
  PolicyReason,
  ProposalDetail,
  ProposalOp,
} from '../../../api/generated/opsAgentAPI.schemas';
import { DrawerFact as Fact, SideDrawer } from '../../system/components/side-drawer';
import { Pill } from '../../proposals/components/badges';
import { PolicyReasons } from '../../proposals/components/policy-panel';
import { ACTOR_KIND_LABELS, actionLabel, actorName } from '../../proposals/proposal-values';
import { useLocationNames, useProposal } from '../../proposals/proposals-api';
import { opLabel } from '../../proposals/proposal-record';
import {
  auditJson,
  formatAuditValue,
  mismatchRows,
  opFieldRows,
  type DrawerChange,
} from '../audit-changes';
import {
  opRefs,
  resolveRef,
  resolveText,
  splitRefs,
  type OpRefMatch,
  type Resolution,
} from '../audit-refs';
import { auditDetail, auditSentence, auditTypeOf } from '../audit-values';
import { outcomeOf } from './audit-table';

const mono = css({
  fontFamily: 'mono',
  fontSize: '1',
  overflowWrap: 'anywhere',
  whiteSpace: 'pre-wrap',
});

const str = (value: unknown) => (typeof value === 'string' && value ? value : null);

const isReason = (value: unknown): value is PolicyReason =>
  Boolean(value && typeof value === 'object' && 'rule' in value && 'message' in value && 'outcome' in value);

const errorOf = (event: AuditEvent): { message: string; code: string | null } | null => {
  const error = event.data.error;
  if (!error || typeof error !== 'object' || !('message' in error)) return null;
  const message = str(error.message);
  if (!message) return null;
  return { message, code: 'code' in error ? str(error.code) : null };
};

const fullTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });

const copy = (label: string, value: string) =>
  void navigator.clipboard
    .writeText(value)
    .then(() => toast.success(`${label} copied.`))
    .catch(() => toast.error('Copy failed. Select the text and copy it.'));

/** An id with a copy button (carbonme mcp-setup-card's copy action, as a chip). */
const IdChip = ({
  icon,
  label,
  value,
  suffix,
}: {
  icon: keyof typeof Icons;
  label: string;
  value: string;
  suffix?: string;
}) => {
  const Icon = Icons[icon];
  return (
    <HStack
      gap="2"
      px="2.5"
      py="1.5"
      rounded="lg"
      bg="background.app"
      fontSize="1"
      minW="0"
      alignItems="flex-start"
      data-audit-id={label}
    >
      <styled.span color="text.muted" display="flex" mt="0.5" flexShrink="0">
        <Icon size={12} />
      </styled.span>
      <Flex direction="column" minW="0" flex="1">
        <styled.span color="text.muted">{label}</styled.span>
        <styled.span className={mono} color="text.app">
          {value}
          {suffix ? <styled.span color="text.muted"> · {suffix}</styled.span> : null}
        </styled.span>
      </Flex>
      <Button
        variant="ghost"
        size="icon"
        flexShrink="0"
        aria-label={`Copy ${label.toLowerCase()}`}
        title="Copy"
        onClick={() => copy(label, value)}
      >
        <Icons.copy size={13} />
      </Button>
    </HStack>
  );
};

const RefChip = ({
  refMatch,
  resolution,
  proposalId,
}: {
  refMatch: OpRefMatch;
  resolution: Resolution;
  proposalId: string | null;
}) => (
  <styled.span display="inline" data-op-ref={refMatch.token}>
    <styled.code
      fontFamily="mono"
      fontSize="0.719rem"
      px="1"
      py="0.5"
      rounded="sm"
      bg="brand.panel.5"
      color="text.label"
      overflowWrap="anywhere"
    >
      {refMatch.token}
    </styled.code>{' '}
    <styled.span color="text.muted">→</styled.span>{' '}
    {resolution ? (
      <styled.b fontWeight="600" color="text.app" data-op-ref-value="">
        {String(resolution.value)}
      </styled.b>
    ) : (
      <styled.span color="text.muted" fontStyle="italic">
        not resolved yet
      </styled.span>
    )}
    {proposalId ? (
      <>
        {' '}
        <Link
          to="/approvals/$proposalId"
          params={{ proposalId }}
          hash={`op-${refMatch.index}`}
          className={css({ color: 'text.muted', fontSize: '1', textDecoration: 'underline', textUnderlineOffset: '2px', _hover: { color: 'text.app' } })}
        >
          op {refMatch.index + 1}
        </Link>
      </>
    ) : null}
  </styled.span>
);

/** One side of a change: a person's reading of the value, the stored form underneath when it differs. */
const Value = ({
  change,
  side,
  resolve,
  proposalId,
}: {
  change: DrawerChange;
  side: 'before' | 'after';
  resolve: (ref: OpRefMatch) => Resolution;
  proposalId: string | null;
}) => {
  const value = change[side];
  if (typeof value === 'string' && splitRefs(value).some((part) => typeof part !== 'string')) {
    return (
      <styled.span fontSize="1.5" lineHeight="1.7" overflowWrap="anywhere">
        {splitRefs(value).map((part, index) =>
          typeof part === 'string' ? (
            <span key={index}>{part}</span>
          ) : (
            <RefChip key={index} refMatch={part} resolution={resolve(part)} proposalId={proposalId} />
          ),
        )}
      </styled.span>
    );
  }
  const formatted = formatAuditValue(change.field, value);
  return (
    <Flex direction="column" gap="0.5" minW="0">
      <styled.span
        className={formatted.mono ? mono : undefined}
        fontSize={formatted.mono ? undefined : '1.5'}
        overflowWrap="anywhere"
        whiteSpace="pre-wrap"
        color={formatted.empty ? 'text.placeholder' : undefined}
        fontStyle={formatted.empty && !formatted.mono ? 'italic' : undefined}
      >
        {formatted.text}
      </styled.span>
      {formatted.raw ? (
        <styled.span className={mono} color="text.muted" fontSize="0.656rem">
          {formatted.raw}
        </styled.span>
      ) : null}
    </Flex>
  );
};

const KIND_MARKS: Record<DrawerChange['kind'], { label: string; className: string } | null> = {
  added: { label: 'Added', className: css({ bg: 'palette.green.3', color: 'palette.green.11' }) },
  removed: { label: 'Removed', className: css({ bg: 'brand.error.3', color: 'text.error' }) },
  changed: { label: 'Changed', className: css({ bg: 'palette.blue.3', color: 'palette.blue.11' }) },
  unchanged: null,
};

const changeRow = css({
  bg: 'background.app',
  '& > td': { px: '3', py: '2', verticalAlign: 'top' },
  '& > td:first-child': { borderLeftRadius: 'lg' },
  '& > td:last-child': { borderRightRadius: 'lg' },
});

/** carbonme's Changes table (field | before | after), every value wrapping; the after of a change tinted. */
const Changes = ({
  rows,
  headings,
  resolve,
  proposalId,
}: {
  rows: DrawerChange[];
  headings: [string, string, string];
  resolve: (ref: OpRefMatch) => Resolution;
  proposalId: string | null;
}) => (
  <div className={css({ bg: 'brand.panel.3', borderRadius: 'xl', p: '1.5' })}>
    <table
      className={css({
        borderCollapse: 'separate',
        borderSpacing: '0 4px',
        fontSize: '1.5',
        tableLayout: 'fixed',
        w: 'full',
      })}
    >
      <colgroup>
        <col className={css({ w: '30%' })} />
        <col className={css({ w: '35%' })} />
        <col className={css({ w: '35%' })} />
      </colgroup>
      <thead>
        <tr>
          {headings.map((heading) => (
            <th
              key={heading}
              className={css({
                color: 'text.muted',
                fontSize: '1',
                fontWeight: 'normal',
                px: '3',
                py: '1',
                textAlign: 'left',
              })}
            >
              {heading}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((change) => {
          const mark = KIND_MARKS[change.kind];
          return (
            <tr key={`${change.kind}:${change.field}`} data-audit-change={change.field} data-change-kind={change.kind} className={changeRow}>
              <td>
                <Flex direction="column" gap="1" alignItems="flex-start" minW="0">
                  <span className={mono}>{change.field}</span>
                  {mark ? (
                    <styled.span fontSize="0.656rem" fontWeight="500" px="1.5" rounded="sm" className={mark.className}>
                      {mark.label}
                    </styled.span>
                  ) : null}
                </Flex>
              </td>
              <td
                className={cx(
                  css({ color: 'text.muted' }),
                  change.kind === 'removed' ? css({ textDecoration: 'line-through', textDecorationColor: 'text.error' }) : undefined,
                )}
              >
                <Value change={change} side="before" resolve={resolve} proposalId={proposalId} />
              </td>
              <td
                className={
                  change.kind === 'unchanged'
                    ? css({ color: 'text.muted' })
                    : change.kind === 'removed'
                      ? undefined
                      : css({ bg: 'palette.blue.2' })
                }
              >
                <Value change={change} side="after" resolve={resolve} proposalId={proposalId} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);

const Section = ({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) => (
  <section className={css({ display: 'grid', gap: '2', minW: '0' })}>
    <HStack justify="space-between" gap="2">
      <h3 className={css({ fontSize: '1.5', fontWeight: 'semibold' })}>{title}</h3>
      {aside}
    </HStack>
    {children}
  </section>
);

/** carbonme's Json block, folded: the event as the harness stored it. */
const Json = ({ label, value }: { label: string; value: unknown }) => (
  <details className={css({ display: 'grid', gap: '1.5', '& > summary': { cursor: 'pointer' } })}>
    <summary className={css({ color: 'text.muted', fontSize: '1', _hover: { color: 'text.app' } })}>{label}</summary>
    <pre
      className={css({
        bg: 'brand.panel.3',
        borderRadius: 'lg',
        fontFamily: 'mono',
        fontSize: '1',
        lineHeight: '1.6',
        mt: '1.5',
        p: '3',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
      })}
    >
      {auditJson(value)}
    </pre>
  </details>
);

/** The op's changes: the diff first, unchanged fields folded underneath. */
const OpChanges = ({
  event,
  op,
  ops,
  proposalId,
}: {
  event: AuditEvent;
  op: ProposalOp;
  ops: readonly ProposalOp[];
  proposalId: string;
}) => {
  const [showUnchanged, setShowUnchanged] = useState(false);
  const rows = opFieldRows(op);
  const changed = rows.filter((row) => row.kind !== 'unchanged');
  const unchanged = rows.filter((row) => row.kind === 'unchanged');
  const resolve = (ref: OpRefMatch) => resolveRef(ref, event, op, ops);
  const refs = opRefs(event, op, ops);
  return (
    <>
      {refs.length > 0 && (
        <Section title="Resolved references">
          <styled.ul listStyle="none" m="0" p="1.5" rounded="xl" bg="brand.panel.3" display="grid" gap="1" data-testid="audit-refs">
            {refs.map(({ ref, resolution }) => (
              <styled.li key={ref.token} px="3" py="2" rounded="lg" bg="background.app" fontSize="1.5" lineHeight="1.7">
                <RefChip refMatch={ref} resolution={resolution} proposalId={proposalId} />
                <styled.span color="text.muted" fontSize="1">
                  {' '}
                  · {ref.field} of {actionLabel(ops.find((item) => item.index === ref.index)?.action ?? 'op').toLowerCase()}
                  {resolution && !resolution.applied ? ' (applied when this op is written)' : ''}
                </styled.span>
              </styled.li>
            ))}
          </styled.ul>
        </Section>
      )}
      <Section
        title="Changes"
        aside={
          <styled.span color="text.muted" fontSize="1">
            {changed.length} changed{unchanged.length ? ` · ${unchanged.length} unchanged` : ''}
          </styled.span>
        }
      >
        {changed.length === 0 ? (
          <p className={css({ color: 'text.muted', fontSize: '1.5' })}>Nothing changed.</p>
        ) : (
          <Changes rows={changed} headings={['Field', 'Before', 'After']} resolve={resolve} proposalId={proposalId} />
        )}
        {unchanged.length > 0 && (
          <>
            <Button
              variant="ghost"
              size="xs"
              justifySelf="start"
              color="text.muted"
              aria-expanded={showUnchanged}
              onClick={() => setShowUnchanged((open) => !open)}
              data-audit-unchanged-toggle=""
            >
              {showUnchanged ? <Icons.caretUp size={12} /> : <Icons.caretDown size={12} />}
              {showUnchanged ? 'Hide' : 'Show'} {unchanged.length} unchanged field{unchanged.length === 1 ? '' : 's'}
            </Button>
            {showUnchanged && (
              <Changes rows={unchanged} headings={['Field', 'Before', 'After']} resolve={resolve} proposalId={proposalId} />
            )}
          </>
        )}
      </Section>
    </>
  );
};

/** What the event changed or decided, by type. */
const EventBody = ({
  event,
  proposal,
  loading,
}: {
  event: AuditEvent;
  proposal: ProposalDetail | undefined;
  loading: boolean;
}) => {
  const ops = proposal?.ops ?? [];
  const op = event.opIndex !== null ? ops.find((item) => item.index === event.opIndex) : undefined;
  const reasons = Array.isArray(event.data.reasons) ? event.data.reasons.filter(isReason) : null;
  const error = errorOf(event);
  const noResolve = () => null;
  return (
    <>
      {error && (
        <HStack gap="2.5" alignItems="flex-start" px="3" py="2.5" rounded="lg" bg="brand.error.3" color="text.error" fontSize="1.5" role="alert">
          <Icons.alertCircle size={14} flexShrink="0" mt="0.5" />
          <span className={css({ overflowWrap: 'anywhere' })}>
            {error.message}
            {error.code ? <span className={css({ fontFamily: 'mono', fontSize: '1' })}> ({error.code})</span> : null}
          </span>
        </HStack>
      )}
      {reasons && reasons.length > 0 && (
        <Section title="Rule verdicts">
          <Box p="1.5" rounded="xl" bg="brand.panel.3" data-testid="audit-policy">
            <PolicyReasons reasons={reasons} />
          </Box>
        </Section>
      )}
      {event.type === 'op.verify_failed' && (
        <Section title="Expected vs actual">
          <Changes rows={mismatchRows(event)} headings={['Field', 'Expected', 'Actual']} resolve={noResolve} proposalId={event.proposalId} />
        </Section>
      )}
      {event.type !== 'op.verify_failed' && event.opIndex !== null && event.proposalId ? (
        op ? (
          <OpChanges event={event} op={op} ops={ops} proposalId={event.proposalId} />
        ) : loading ? (
          <p className={css({ color: 'text.muted', fontSize: '1.5' })}>Loading the op’s diff…</p>
        ) : null
      ) : null}
    </>
  );
};

/** The drawer's content for one event: pills, facts, what it changed, ids, raw data. */
const AuditDrawerBody = ({
  event,
  title,
  proposal,
  loading,
  stepping,
}: {
  event: AuditEvent;
  title: string | null;
  proposal: ProposalDetail | undefined;
  loading: boolean;
  stepping: boolean;
}) => {
  const outcome = outcomeOf(event);
  const locations = useLocationNames();
  const locationNames = useMemo(() => new Map((locations.data ?? []).map((item) => [item.id, item.name])), [locations.data]);
  const op = event.opIndex !== null ? proposal?.ops.find((item) => item.index === event.opIndex) : undefined;
  const key = str(event.data.idempotencyKey) ?? op?.idempotencyKey ?? null;
  const record = str(event.data.recordId) ?? op?.result?.recordId ?? null;
  const proposalTitle = title ?? proposal?.title ?? null;
  const action = str(event.data.action) ?? op?.action ?? null;
  const chip = css({
    fontFamily: 'mono',
    fontSize: '0.656rem',
    px: '1.5',
    h: '18px',
    display: 'inline-flex',
    alignItems: 'center',
    rounded: 'md',
    bg: 'brand.panel.5',
    color: 'text.label',
  });

  return (
    <>
      <HStack gap="1.5" flexWrap="wrap">
        <Pill tone={outcome.tone} label={outcome.label} data-audit-outcome={outcome.key} />
        <code className={chip}>{event.type}</code>
        {action ? <code className={chip}>{action}</code> : null}
        <styled.span color="text.muted" fontSize="1">
          {auditTypeOf(event.type).label}
        </styled.span>
      </HStack>

      <dl className={css({ display: 'grid', gap: '3', gridTemplateColumns: { base: '1fr', sm: '1fr 1fr' } })}>
        <Fact label="Who">
          {actorName(event.actor)} · {ACTOR_KIND_LABELS[event.actor.kind]}
          {event.actor.scopes?.length ? (
            <styled.span display="block" color="text.muted" fontSize="1" mt="0.5">
              {event.actor.scopes.join(' · ')}
            </styled.span>
          ) : null}
        </Fact>
        <Fact label="Proposal">
          {event.proposalId ? (
            <Link
              to="/approvals/$proposalId"
              params={{ proposalId: event.proposalId }}
              className={css({ textDecoration: 'underline', textUnderlineOffset: '2px' })}
              data-audit-open-proposal=""
            >
              {proposalTitle ?? `Proposal ${event.proposalId.slice(0, 8)}`}
            </Link>
          ) : (
            'Harness'
          )}
        </Fact>
        {event.opIndex !== null && event.proposalId ? (
          <Fact label="Op">
            <Link
              to="/approvals/$proposalId"
              params={{ proposalId: event.proposalId }}
              hash={`op-${event.opIndex}`}
              className={css({ textDecoration: 'underline', textUnderlineOffset: '2px' })}
              data-audit-jump-op={event.opIndex}
            >
              Op {event.opIndex + 1}
              {proposal ? ` of ${proposal.ops.length}` : ''}
            </Link>
            {op ? (
              <styled.span color="text.muted" data-audit-op-label="">
                {' '}
                · {opLabel(op, proposal?.ops ?? [], locationNames)}
              </styled.span>
            ) : null}
            {op?.summary ? (
              <styled.span display="block" color="text.muted" fontSize="1" mt="0.5" title={op.summary}>
                {resolveText(op.summary, (ref) => resolveRef(ref, event, op, proposal?.ops ?? []))}
              </styled.span>
            ) : null}
          </Fact>
        ) : null}
        <Fact label="Actor id">
          <span className={mono}>{event.actor.id}</span>
        </Fact>
      </dl>

      <EventBody event={event} proposal={proposal} loading={loading} />

      <Section title="Ids">
        <Box display="grid" gridTemplateColumns={{ base: '1fr', sm: '1fr 1fr' }} gap="1.5" p="1.5" rounded="xl" bg="brand.panel.3">
          <IdChip icon="hash" label="Event" value={event.id} suffix={`seq ${event.seq}`} />
          {key ? <IdChip icon="key" label="Idempotency key" value={key} /> : null}
          {record ? <IdChip icon="database" label="Record" value={record} /> : null}
          {event.proposalId ? <IdChip icon="document" label="Proposal" value={event.proposalId} /> : null}
        </Box>
      </Section>

      <Json label="Event data as recorded" value={event.data} />

      <HStack gap="3" color="text.muted" fontSize="1" justify="flex-end">
        {stepping ? (
          <HStack gap="1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            <span>events</span>
          </HStack>
        ) : null}
        <HStack gap="1">
          <Kbd>Esc</Kbd>
          <span>close</span>
        </HStack>
      </HStack>
    </>
  );
};

const ProposalDrawerBody = (props: Omit<Parameters<typeof AuditDrawerBody>[0], 'proposal' | 'loading'> & { proposalId: string }) => {
  const proposal = useProposal(props.proposalId);
  return <AuditDrawerBody {...props} proposal={proposal.data} loading={proposal.isPending} />;
};

/**
 * The audit drawer for whichever event is open (`?event=<id>`), or closed. Used by the audit log and the proposal
 * trail. The sheet stays mounted while ↑/↓ step between events; only its content changes.
 */
export const AuditDrawer = ({
  event,
  title = null,
  onClose,
  onStep = null,
  position = null,
}: {
  event: AuditEvent | null;
  title?: string | null;
  onClose: () => void;
  onStep?: ((direction: -1 | 1) => void) | null;
  position?: { index: number; total: number } | null;
}) => {
  const onKeyDown = (key: KeyboardEvent<HTMLDivElement>) => {
    if (!onStep || key.altKey || key.metaKey || key.ctrlKey) return;
    const target = key.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable=true]')) return;
    if (key.key === 'ArrowDown' || key.key === 'ArrowUp') {
      key.preventDefault();
      onStep(key.key === 'ArrowDown' ? 1 : -1);
    }
  };
  const detail = event ? auditDetail(event) : null;
  const stepping = Boolean(onStep && position && position.total > 1);

  return (
    <SideDrawer
      open={event !== null}
      onClose={onClose}
      width="46rem"
      title={event ? auditSentence(event, title) : ''}
      description={
        event ? (
          <>
            {fullTime(event.at)}
            {detail ? (
              <styled.span display="block" mt="0.5" overflowWrap="anywhere">
                {detail}
              </styled.span>
            ) : null}
          </>
        ) : null
      }
      onKeyDown={onKeyDown}
      data-testid="audit-drawer"
      data-audit-drawer={event?.type}
      actions={
        stepping && onStep && position ? (
          <HStack gap="0.5" mr="1">
            <styled.span color="text.muted" fontSize="1" mr="1" fontVariantNumeric="tabular-nums" whiteSpace="nowrap">
              {position.index + 1} / {position.total}
            </styled.span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Previous event"
              title="Previous event (↑)"
              disabled={position.index === 0}
              onClick={() => onStep(-1)}
            >
              <Icons.arrowUp size={14} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Next event"
              title="Next event (↓)"
              disabled={position.index >= position.total - 1}
              onClick={() => onStep(1)}
            >
              <Icons.arrowDown size={14} />
            </Button>
          </HStack>
        ) : null
      }
    >
      {event ? (
        event.proposalId ? (
          <ProposalDrawerBody key={event.id} event={event} title={title} stepping={stepping} proposalId={event.proposalId} />
        ) : (
          <AuditDrawerBody key={event.id} event={event} title={title} stepping={stepping} proposal={undefined} loading={false} />
        )
      ) : null}
    </SideDrawer>
  );
};
