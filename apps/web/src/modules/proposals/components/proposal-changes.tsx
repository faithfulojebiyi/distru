// The Changes tab of the proposal record page. Rows follow carbonme modules/chats/chat-tool-runs.tsx ToolCallCard (a
// collapsed heading that opens to what it ran with) inside the hairline list of carbonme
// apps/admin/src/modules/customers/customers-page.tsx; the filter chips are the approvals inbox's FilterChip row
// (carbonme admin customers-page.tsx filters) and the status pills carbonme's ToolRunBadge tones.
import { useMemo } from 'react';
import { Box, Flex, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { Button } from '@ops/ui/primitives/button';
import { Span } from '@ops/ui/primitives/text';
import type { ProposalDetail, ProposalOp } from '../../../api/generated/opsAgentAPI.schemas';
import { formatDateTime, formatInline, formatMoney, formatPath, fieldOf } from '../proposal-values';
import { opLabel, systemOf, type SystemGroup } from '../proposal-record';
import { Pill, RiskBadge, TONES } from './badges';
import { DiffCounts, DiffView } from './diff-view';

export const OP_STATUS = {
  pending: { tone: TONES.muted, label: 'Not written' },
  executed: { tone: TONES.good, label: 'Written' },
  failed: { tone: TONES.bad, label: 'Failed' },
} as const;

const Fact = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <Flex direction="column" gap="0.5" minW="0">
    <Span fontSize="1" color="text.muted">
      {label}
    </Span>
    <Box fontSize="1.5" minW="0">
      {children}
    </Box>
  </Flex>
);

/** What the executor did with one op: the record it wrote, attempts, dedupe, verify mismatches, error. */
const OpResult = ({ op }: { op: ProposalOp }) => {
  const result = op.result;
  if (!result) return null;
  const failed = op.status === 'failed';
  return (
    <Flex
      direction="column"
      gap="2.5"
      px="3"
      py="2.5"
      borderTopWidth="1px"
      borderColor="border.subtle"
      bg={failed ? 'brand.error.2' : undefined}
      data-op-result={op.status}
    >
      <HStack gap="5" flexWrap="wrap" fontSize="1.5">
        <Fact label="Record">
          <styled.code fontFamily="mono" fontSize="1">
            {result.recordId ?? '—'}
          </styled.code>
        </Fact>
        <Fact label="Attempts">{result.attempts}</Fact>
        <Fact label="Duplicate">
          {result.deduplicated ? (
            <HStack gap="1" color="palette.blue.11">
              <Icons.copyCheck size={13} />
              Reused existing record
            </HStack>
          ) : (
            'No'
          )}
        </Fact>
        <Fact label="Finished">{formatDateTime(result.finishedAt)}</Fact>
      </HStack>
      {result.mismatches.length > 0 && (
        <Flex direction="column" gap="1">
          <Span fontSize="1" color="text.error" fontWeight="500">
            Read-after-write found {result.mismatches.length} mismatch{result.mismatches.length === 1 ? '' : 'es'}
          </Span>
          {result.mismatches.map((mismatch, index) => (
            <Span key={`${formatPath(mismatch.path)}:${index}`} fontSize="1" color="text.muted">
              <styled.code fontFamily="mono">{formatPath(mismatch.path)}</styled.code>: expected{' '}
              {mismatch.expected === undefined ? '(nothing)' : formatInline(mismatch.expected, fieldOf(mismatch.path))}, got{' '}
              {mismatch.actual === undefined ? '(nothing)' : formatInline(mismatch.actual, fieldOf(mismatch.path))}
            </Span>
          ))}
        </Flex>
      )}
      {result.error && (
        <HStack gap="2" alignItems="flex-start" fontSize="1.5" color="text.error" role="alert">
          <Icons.alertCircle size={14} flexShrink="0" mt="0.5" />
          <span>
            {result.error.message}
            {result.error.code ? (
              <Span color="text.muted" fontSize="1">
                {' '}
                ({result.error.code})
              </Span>
            ) : null}
          </span>
        </HStack>
      )}
    </Flex>
  );
};

/** One op: a compact sticky row (system, label, risk, status, value) that opens to its diff and result. */
const OpRow = ({
  op,
  ops,
  system,
  open,
  toggle,
}: {
  op: ProposalOp;
  ops: readonly ProposalOp[];
  system: SystemGroup;
  open: boolean;
  toggle: () => void;
}) => {
  const status = OP_STATUS[op.status];
  const SystemIcon = Icons[system.icon];
  return (
    <Box as="article" id={`op-${op.index}`} scrollMarginTop="0" data-op-index={op.index} data-op-open={open ? 'true' : 'false'}>
      <styled.button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        position="sticky"
        top="0"
        zIndex="1"
        w="full"
        display="grid"
        gridTemplateColumns={{ base: 'auto minmax(0, 1fr) auto', lg: 'auto 2rem 9rem minmax(0, 1fr) auto auto 4rem 5.5rem' }}
        alignItems="center"
        gap="3"
        px="3"
        h="11"
        textAlign="left"
        fontSize="1.5"
        cursor="pointer"
        bg="background.app"
        borderBottomWidth="1px"
        borderColor="border.subtle"
        _hover={{ bg: { base: 'brand.panel.2', _dark: 'brand.panel.3' } }}
      >
        <styled.span color="text.muted" display="flex" transform={open ? 'rotate(90deg)' : undefined} transition="transform 0.15s">
          <Icons.caretRight size={12} />
        </styled.span>
        <Span hideBelow="lg" color="text.muted" fontSize="1" fontVariantNumeric="tabular-nums">
          #{op.index + 1}
        </Span>
        <HStack hideBelow="lg" gap="1.5" color="text.label" fontSize="1" minW="0">
          <SystemIcon size={13} flexShrink="0" />
          <Span truncate>{system.label}</Span>
        </HStack>
        <Span fontWeight="500" truncate title={op.summary ?? undefined}>
          {opLabel(op, ops)}
        </Span>
        <Box hideBelow="lg">{op.risk ? <RiskBadge risk={op.risk} /> : null}</Box>
        <Pill tone={status.tone} label={status.label} data-op-status={op.status} />
        <Box hideBelow="lg" justifySelf="end">
          <DiffCounts diff={op.diff} />
        </Box>
        <Span hideBelow="lg" justifySelf="end" fontWeight="500" fontVariantNumeric="tabular-nums">
          {op.value ? formatMoney(op.value) : '—'}
        </Span>
      </styled.button>
      {open ? (
        <Box mx="3" my="2" rounded="lg" bg={{ base: 'brand.panel.2', _dark: 'brand.panel.3' }} overflow="hidden">
          <HStack px="3" py="2" gap="2" fontSize="1" color="text.muted" flexWrap="wrap" borderBottomWidth="1px" borderColor="border.subtle">
            <styled.code fontFamily="mono">{op.action}</styled.code>
            <span>on {op.resource}</span>
            {op.idempotencyKey ? (
              <styled.code fontFamily="mono" title="Idempotency key" truncate>
                · {op.idempotencyKey}
              </styled.code>
            ) : null}
          </HStack>
          <Box bg="background.app">
            <DiffView diff={op.diff} />
          </Box>
          <OpResult op={op} />
        </Box>
      ) : null}
    </Box>
  );
};

const FilterButton = ({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) => (
  <styled.button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    display="inline-flex"
    alignItems="center"
    gap="1.5"
    h="7"
    px="2.5"
    rounded="full"
    fontSize="1"
    whiteSpace="nowrap"
    cursor="pointer"
    borderWidth="1px"
    borderColor={active ? 'transparent' : 'border.subtle'}
    bg={active ? 'brand.panel.5' : 'transparent'}
    color={active ? 'text.app' : 'text.label'}
    fontWeight={active ? '500' : '400'}
    _hover={{ bg: 'brand.panel.4' }}
    data-changes-filter={label}
  >
    {label}
    <styled.span color="text.muted" fontVariantNumeric="tabular-nums">
      {count}
    </styled.span>
  </styled.button>
);

/** Changes: filter chips by system, Expand / Collapse all, then the op rows in their own scroll container. */
export const ProposalChanges = ({
  proposal,
  open,
  setOpen,
  system,
  setSystem,
}: {
  proposal: ProposalDetail;
  open: ReadonlySet<number>;
  setOpen: (open: ReadonlySet<number>) => void;
  system: string | null;
  setSystem: (system: string | null) => void;
}) => {
  const summaries = useMemo(() => new Map(proposal.opSummaries.map((summary) => [summary.index, summary])), [proposal.opSummaries]);
  const rows = proposal.ops.map((op) => ({ op, system: systemOf(op.action, summaries.get(op.index)) }));
  const systems = [...new Map(rows.map((row) => [row.system.key, row.system])).values()];
  const shown = rows.filter((row) => !system || row.system.key === system);

  return (
    <Flex direction="column" h="full" minH="0" data-testid="proposal-changes">
      <HStack gap="1.5" px="5" py="2.5" flexWrap="wrap" flexShrink="0" borderBottomWidth="1px" borderColor="border.subtle">
        <FilterButton label="All" count={rows.length} active={!system} onClick={() => setSystem(null)} />
        {systems.map((item) => (
          <FilterButton
            key={item.key}
            label={item.label}
            count={rows.filter((row) => row.system.key === item.key).length}
            active={system === item.key}
            onClick={() => setSystem(system === item.key ? null : item.key)}
          />
        ))}
        <HStack gap="1" ml="auto">
          <Button size="xs" variant="ghost" onClick={() => setOpen(new Set(shown.map((row) => row.op.index)))} data-expand-all="">
            Expand all
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setOpen(new Set())} data-collapse-all="">
            Collapse all
          </Button>
        </HStack>
      </HStack>
      <Box flex="1" minH="0" overflowY="auto" data-changes-scroll="">
        {shown.map(({ op, system: group }) => (
          <OpRow
            key={op.index}
            op={op}
            ops={proposal.ops}
            system={group}
            open={open.has(op.index)}
            toggle={() => {
              const next = new Set(open);
              if (next.has(op.index)) next.delete(op.index);
              else next.add(op.index);
              setOpen(next);
            }}
          />
        ))}
      </Box>
    </Flex>
  );
};
