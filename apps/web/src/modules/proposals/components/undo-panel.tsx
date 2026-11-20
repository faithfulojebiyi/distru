// Adapted from carbonme modules/chats/chat-tool-runs.tsx ToolApprovalCard (a brand.panel.3 card with a heading, a
// status pill, an amber note where the action changes data, and buttons that spin while their request is sent) and
// modules/settings/delete-workspace.tsx (the inline role="alert" failure under a destructive action). The op list
// reuses carbonme modules/integrations/mcp-custom-servers.tsx row styling (background.app rows on the grey card).
import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Box, Flex, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { Button } from '@ops/ui/primitives/button';
import { Checkbox } from '@ops/ui/primitives/checkbox/checkbox';
import { Textarea } from '@ops/ui/primitives/textarea';
import { Span } from '@ops/ui/primitives/text';
import { isRouteMissingError } from '../../../api/errors';
import type {
  ProposalDetail,
  ProposalOp,
  UndoOpInfo,
} from '../../../api/generated/opsAgentAPI.schemas';
import { RecordIcon } from '../../system/components/record-tabs';
import { formatDateTime } from '../proposal-values';
import { opLabel } from '../proposal-record';
import { useDiffNames } from './diff-view';
import {
  undoFailureOf,
  useProposal,
  useResumeProposal,
  useUndoProposal,
} from '../proposals-api';
import { AMBER_TINT, Pill, TONES } from './badges';

const REF = /\{\{op:(\d+)\.([A-Za-z0-9_]+)\}\}/g;

/** "Email {{op:0.purchase_number}} to …" → "Email PO-527 to …", from what the referenced op wrote. */
const resolveSummary = (text: string, ops: readonly ProposalOp[]) =>
  text.replace(REF, (token, index: string, field: string) => {
    const source = ops.find((op) => op.index === Number(index));
    const result = source?.status === 'executed' ? source.result : null;
    if (!result) return token;
    if (field === 'recordId') return result.recordId ?? token;
    const value: unknown = result.outputs?.[field];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : token;
  });

/** The record page's op label for an undo row ("Purchase order PO-524 → … · Oakland Warehouse"). */
const useOpLabels = (proposal: ProposalDetail) => {
  const names = useDiffNames();
  return (info: UndoOpInfo) => {
    const op = proposal.ops.find((item) => item.index === info.opIndex);
    return op ? opLabel(op, proposal.ops, names) : `Op ${info.opIndex + 1}`;
  };
};

/** Why an op stays as it is, worded as the reason the server gave ("can't be undone: …"). */
const cannotUndo = (op: UndoOpInfo) =>
  op.undoProposalId ? 'Already in an undo proposal' : `Can’t be undone: ${op.reason ?? 'no compensating action'}`;

const OpRow = ({
  op,
  label,
  summary,
  checked,
  disabled,
  toggle,
}: {
  op: UndoOpInfo;
  /** "Purchase order PO-524 → Golden State Edibles · Oakland Warehouse". */
  label: string;
  summary: string;
  checked: boolean;
  disabled: boolean;
  toggle: (on: boolean) => void;
}) => {
  const undoable = op.canUndo && !op.undoProposalId;
  return (
    <styled.li
      display="flex"
      alignItems="flex-start"
      gap="2.5"
      px="3"
      py="2"
      rounded="lg"
      bg={{ base: 'background.app', _dark: 'brand.panel.4' }}
      fontSize="1.5"
      data-undo-op={op.opIndex}
      data-can-undo={undoable ? 'true' : 'false'}
    >
      <Box pt="0.5" flexShrink="0">
        {undoable ? (
          <Checkbox
            checked={checked}
            disabled={disabled}
            onCheckedChange={(state) => toggle(state === true)}
            aria-label={`Undo op ${op.opIndex + 1}`}
          />
        ) : (
          <styled.span color="text.muted" display="flex">
            <Icons.ban size={14} />
          </styled.span>
        )}
      </Box>
      <Flex direction="column" gap="0.5" minW="0">
        <HStack gap="1.5" minW="0">
          <Span fontWeight="500" truncate title={label} data-undo-label="">
            {label}
          </Span>
          <Span color="text.muted" fontSize="1" flexShrink="0">
            op {op.opIndex + 1}
          </Span>
        </HStack>
        <Span color={undoable ? 'text.app' : 'text.muted'} fontSize="1" overflowWrap="anywhere">
          {summary}
        </Span>
        {!undoable ? (
          <Span color="text.muted" fontSize="1" data-undo-reason="">
            {cannotUndo(op)}
          </Span>
        ) : null}
      </Flex>
    </styled.li>
  );
};

/** Undo for an executed proposal: which writes can be reversed, a reason, and "Propose undo" → the new proposal. */
const UndoForm = ({ proposal }: { proposal: ProposalDetail }) => {
  const navigate = useNavigate();
  const undo = useUndoProposal(proposal.id);
  const undoable = proposal.undo.ops.filter((op) => op.canUndo && !op.undoProposalId);
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set(undoable.map((op) => op.opIndex)));
  const [reason, setReason] = useState('');
  const labelOf = useOpLabels(proposal);
  const summaries = useMemo(
    () => new Map(proposal.undo.ops.map((op) => [op.opIndex, resolveSummary(op.summary ?? op.action, proposal.ops)])),
    [proposal.undo.ops, proposal.ops],
  );
  const busy = undo.isPending;
  const all = selected.size === undoable.length;

  const submit = () =>
    undo.mutate(
      {
        reason: reason.trim(),
        ...(all ? {} : { opIndexes: [...selected].sort((a, b) => a - b) }),
      },
      {
        onSuccess: ({ proposal: created }) =>
          void navigate({ to: '/approvals/$proposalId', params: { proposalId: created.id } }),
      },
    );

  return (
    <styled.form
      display="flex"
      flexDirection="column"
      gap="3"
      onSubmit={(event) => {
        event.preventDefault();
        if (selected.size > 0 && reason.trim() && !busy) submit();
      }}
    >
      <styled.ul listStyle="none" m="0" p="0" display="flex" flexDirection="column" gap="1" maxH="22rem" overflowY="auto">
        {proposal.undo.ops.map((op) => (
          <OpRow
            key={op.opIndex}
            op={op}
            label={labelOf(op)}
            summary={summaries.get(op.opIndex) ?? op.action}
            checked={selected.has(op.opIndex)}
            disabled={busy}
            toggle={(on) => {
              const next = new Set(selected);
              if (on) next.add(op.opIndex);
              else next.delete(op.opIndex);
              setSelected(next);
            }}
          />
        ))}
      </styled.ul>
      <HStack
        gap="2"
        px="3"
        py="2"
        rounded="lg"
        bg={AMBER_TINT}
        color="palette.amber.11"
        fontSize="1.5"
        alignItems="start"
        data-undo-warning=""
      >
        <Icons.warn size={14} flexShrink="0" mt="0.5" />
        <styled.span>
          Undo creates a new proposal that reverses {selected.size} write{selected.size === 1 ? '' : 's'} in reverse
          order. Nothing changes in Distru until an approver approves it.
        </styled.span>
      </HStack>
      <Box>
        <styled.span fontSize="1" color="text.muted">
          Reason
        </styled.span>
        <Textarea
          mt="1"
          placeholder="Required: why these writes should be reversed"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={2000}
          rows={2}
          minH="0"
          h="4.5rem"
          disabled={busy}
          aria-label="Undo reason"
          bg={{ base: 'background.app', _dark: 'brand.panel.4' }}
        />
      </Box>
      {undo.isError ? (
        <HStack
          gap="2"
          alignItems="flex-start"
          px="3"
          py="2.5"
          rounded="lg"
          bg="brand.error.3"
          color="text.error"
          fontSize="1.5"
          role="alert"
          data-undo-failure=""
        >
          <Icons.warn size={14} flexShrink="0" mt="0.5" />
          <span>{undoFailureOf(undo.error)}</span>
        </HStack>
      ) : null}
      <HStack gap="2" justify="space-between" flexWrap="wrap">
        <Span color="text.muted" fontSize="1">
          {proposal.undo.until ? `Available until ${formatDateTime(proposal.undo.until)}` : null}
        </Span>
        <Button size="xs" type="submit" disabled={busy || selected.size === 0 || !reason.trim()} data-undo-submit="">
          {busy ? <Icons.loading size={13} /> : <Icons.undo size={13} />}
          Propose undo
        </Button>
      </HStack>
    </styled.form>
  );
};

/** On an executed (or partly executed) proposal: the Undo card, ToolApprovalCard's frame. */
export const UndoPanel = ({ proposal }: { proposal: ProposalDetail }) => {
  const { undo } = proposal;
  const labelOf = useOpLabels(proposal);
  const written = proposal.ops.some((op) => op.status === 'executed');
  if (!written || undo.ops.length === 0) return null;
  const proposed = undo.undoProposalId;
  const pill = proposed
    ? { tone: TONES.info, label: 'Undo proposed' }
    : undo.available
      ? { tone: TONES.waiting, label: 'Can undo' }
      : { tone: TONES.muted, label: 'Not available' };
  const undoableCount = undo.ops.filter((op) => op.canUndo && !op.undoProposalId).length;

  return (
    <Flex
      direction="column"
      gap="3"
      p="3"
      rounded="xl"
      bg="brand.panel.3"
      role="group"
      aria-label="Undo"
      data-testid="undo-panel"
    >
      <HStack gap="2.5" minW="0">
        <RecordIcon icon="undo" size="sm" />
        <Box minW="0" flex="1">
          <styled.p fontSize="1.5" fontWeight="500" truncate>
            Undo
          </styled.p>
          <styled.p fontSize="1" color="text.muted" truncate>
            {undoableCount} of {undo.ops.length} write{undo.ops.length === 1 ? '' : 's'} can be reversed
          </styled.p>
        </Box>
        <Pill tone={pill.tone} label={pill.label} data-undo-state={proposed ? 'proposed' : undo.available ? 'available' : 'unavailable'} />
      </HStack>
      {proposed ? (
        <Link to="/approvals/$proposalId" params={{ proposalId: proposed }} data-undo-link="">
          <HStack
            gap="2"
            px="3"
            py="2"
            rounded="lg"
            bg={{ base: 'background.app', _dark: 'brand.panel.4' }}
            fontSize="1.5"
            _hover={{ bg: { base: 'brand.panel.2', _dark: 'brand.panel.6' } }}
          >
            <Icons.undo size={14} />
            <styled.span flex="1">Open the undo proposal</styled.span>
            <Icons.caretRight size={12} />
          </HStack>
        </Link>
      ) : null}
      {undo.available && !proposed ? (
        <UndoForm proposal={proposal} />
      ) : !proposed ? (
        <Flex direction="column" gap="2">
          <Span color="text.muted" fontSize="1.5" data-undo-unavailable="">
            {undo.reason ?? 'None of these writes can be undone.'}
          </Span>
          <styled.ul listStyle="none" m="0" p="0" display="flex" flexDirection="column" gap="1">
            {undo.ops.map((op) => (
              <OpRow
                key={op.opIndex}
                op={{ ...op, canUndo: false }}
                label={labelOf(op)}
                summary={resolveSummary(op.summary ?? op.action, proposal.ops)}
                checked={false}
                disabled
                toggle={() => undefined}
              />
            ))}
          </styled.ul>
        </Flex>
      ) : null}
    </Flex>
  );
};

/** On a compensating proposal: "Undo of <original>", linking back (carbonme's info banner tone). */
export const UndoOfBanner = ({ originalId }: { originalId: string }) => {
  const original = useProposal(originalId);
  return (
    <HStack
      gap="2.5"
      px="4"
      py="2.5"
      rounded="xl"
      bg="palette.blue.3"
      color="palette.blue.11"
      fontSize="1.5"
      data-undo-of={originalId}
    >
      <Icons.undo size={14} />
      <span>
        Undo of{' '}
        <Link to="/approvals/$proposalId" params={{ proposalId: originalId }}>
          <styled.span fontWeight="500" textDecoration="underline" textUnderlineOffset="2px">
            {original.data?.title ?? `proposal ${originalId.slice(0, 8)}`}
          </styled.span>
        </Link>
        . Approving it reverses the writes listed below.
      </span>
    </HStack>
  );
};

/**
 * A failed proposal can be resumed from the op that failed: finished writes keep their idempotency keys, so nothing
 * is written twice. Until the server has the resume route, the card says so instead of failing loudly.
 */
export const ResumePanel = ({ proposal }: { proposal: ProposalDetail }) => {
  const resume = useResumeProposal(proposal.id);
  if (!proposal.resumable && proposal.status !== 'failed') return null;
  const failedOp = proposal.ops.find((op) => op.status === 'failed');
  const missing = resume.isError && isRouteMissingError(resume.error);
  return (
    <Flex direction="column" gap="3" p="3" rounded="xl" bg="brand.panel.3" role="group" aria-label="Resume" data-testid="resume-panel">
      <HStack gap="2.5" minW="0">
        <RecordIcon icon="refresh" size="sm" />
        <Box minW="0" flex="1">
          <styled.p fontSize="1.5" fontWeight="500" truncate>
            Resume execution
          </styled.p>
          <styled.p fontSize="1" color="text.muted" truncate>
            {failedOp ? `Stopped at op ${failedOp.index + 1} of ${proposal.ops.length}` : 'Execution stopped'}
          </styled.p>
        </Box>
        <Pill tone={TONES.bad} label="Failed" />
      </HStack>
      <Span color="text.muted" fontSize="1.5">
        Resuming retries from the op that failed. Writes that already finished reuse their idempotency keys, so they are
        not repeated.
      </Span>
      {missing ? (
        <Span color="text.muted" fontSize="1.5" role="status" data-resume-unavailable="">
          Resume isn’t available on this server yet.
        </Span>
      ) : resume.isError ? (
        <HStack gap="2" alignItems="flex-start" px="3" py="2.5" rounded="lg" bg="brand.error.3" color="text.error" fontSize="1.5" role="alert">
          <Icons.warn size={14} flexShrink="0" mt="0.5" />
          <span>{undoFailureOf(resume.error)}</span>
        </HStack>
      ) : null}
      <HStack justify="flex-end">
        <Button size="xs" disabled={resume.isPending || missing} onClick={() => resume.mutate()} data-resume="">
          {resume.isPending ? <Icons.loading size={13} /> : <Icons.refresh size={13} />}
          Resume
        </Button>
      </HStack>
    </Flex>
  );
};
