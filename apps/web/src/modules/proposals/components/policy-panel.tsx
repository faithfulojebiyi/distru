// Policy verdict list; rows follow carbonme ToolApprovalCard's grey card with background.app rows.
import { css } from '@ops/ui/css';
import { Flex, HStack, styled } from '@ops/ui/jsx';

import type { ReactNode } from 'react';
import { Icons } from '@ops/ui/icons/base';
import { Span } from '@ops/ui/primitives/text';
import type {
  PolicyEvaluation,
  PolicyReason,
} from '../../../api/generated/opsAgentAPI.schemas';
import { PolicyBadge } from './badges';
import { actionLabel } from '../proposal-values';

const REASON_STYLES: Record<
  PolicyReason['outcome'],
  { icon: keyof typeof Icons; color: string; label: string }
> = {
  // Literal css() classes: a colour token read out of this table at runtime would never be generated.
  pass: { icon: 'checkCircle', color: css({ color: 'palette.green.11' }), label: 'Pass' },
  allow: { icon: 'checkCircle', color: css({ color: 'palette.green.11' }), label: 'Allows auto-approval' },
  needs_approval: { icon: 'warn', color: css({ color: 'palette.amber.11' }), label: 'Needs approval' },
  deny: { icon: 'ban', color: css({ color: 'text.error' }), label: 'Deny' },
};

/** "auto_approve_below" → "Auto approve below". */
const ruleName = (rule: string) => {
  const words = rule.replaceAll('_', ' ');
  return `${words[0]?.toUpperCase() ?? ''}${words.slice(1)}`;
};

const ORDER: Record<PolicyReason['outcome'], number> = {
  deny: 0,
  needs_approval: 1,
  allow: 2,
  pass: 3,
};

const OP_REF = /^Op #(\d+) \(([^)]+)\) (.+)$/;

type Row = { rule: string; outcome: PolicyReason['outcome']; message: string; ops: { number: number; action: string }[]; tail: string | null };

/** Verdicts of one rule that differ only by op ("Op #1 (email.send_vendor_po) is high risk") collapse into one row. */
const groupReasons = (reasons: readonly PolicyReason[]): Row[] => {
  const rows: Row[] = [];
  for (const reason of reasons) {
    const match = OP_REF.exec(reason.message);
    const tail = match?.[3] ?? null;
    const existing = match ? rows.find((row) => row.rule === reason.rule && row.outcome === reason.outcome && row.tail === tail) : undefined;
    if (existing && match) existing.ops.push({ number: Number(match[1]), action: match[2] ?? '' });
    else rows.push({ rule: reason.rule, outcome: reason.outcome, message: reason.message, tail, ops: match ? [{ number: Number(match[1]), action: match[2] ?? '' }] : [] });
  }
  return rows.sort((a, b) => ORDER[a.outcome] - ORDER[b.outcome]);
};

/** "is high risk" → "are high risk", for a collapsed row. */
const plural = (tail: string) => tail.replace(/^is /, 'are ').replace(/^has /, 'have ').replace(/^was /, 'were ');

const RowMessage = ({ row, opHref }: { row: Row; opHref?: (index: number) => ReactNode }) => {
  if (row.ops.length < 2 || !row.tail) return <>{row.message}</>;
  const actions = [...new Set(row.ops.map((op) => actionLabel(op.action).toLowerCase()))];
  return (
    <>
      {row.ops.length} ops {plural(row.tail)}:{' '}
      {row.ops.map((op, index) => (
        <span key={op.number}>
          {index > 0 ? ', ' : ''}
          {opHref ? opHref(op.number - 1) : `#${op.number}`}
        </span>
      ))}
      <Span color="text.muted"> — {actions.join(', ')}s</Span>
    </>
  );
};

/** Every policy rule's verdict, the ones that decided the outcome first; repeats of one rule collapse into one row. */
export const PolicyReasons = ({ reasons, opHref }: { reasons: readonly PolicyReason[]; opHref?: (index: number) => ReactNode }) => (
  <styled.ul listStyle="none" m="0" p="0" display="flex" flexDirection="column" gap="1">
    {groupReasons(reasons).map((row, index) => {
      const style = REASON_STYLES[row.outcome];
      const Icon = Icons[style.icon];
      return (
        <styled.li
          key={`${row.rule}:${index}`}
          display="grid"
          gridTemplateColumns="1rem minmax(0, 1fr)"
          columnGap="2.5"
          px="3"
          py="2"
          rounded="lg"
          bg="background.app"
          data-policy-reason={row.outcome}
        >
          <styled.span className={style.color} pt="0.5" title={style.label} aria-label={style.label}>
            <Icon size={14} />
          </styled.span>
          <Flex direction="column" gap="0.5" minW="0">
            <Span fontSize="1.5">
              <RowMessage row={row} opHref={opHref} />
            </Span>
            <Span fontSize="1" color="text.muted">
              {ruleName(row.rule)}
            </Span>
          </Flex>
        </styled.li>
      );
    })}
  </styled.ul>
);

export const PolicyPanel = ({
  policy,
  action,
  opHref,
}: {
  policy: PolicyEvaluation;
  /** A small link in the header, e.g. "Edit policy rules" for approvers. */
  action?: ReactNode;
  opHref?: (index: number) => ReactNode;
}) => (
  <Flex direction="column" gap="3" p="4" rounded="xl" bg="brand.panel.2" data-testid="policy-panel">
    <HStack justify="space-between" gap="2">
      <Span fontWeight="600" fontSize="1.5">
        Policy checks
      </Span>
      <HStack gap="3">
        {action}
        <PolicyBadge outcome={policy.outcome} />
      </HStack>
    </HStack>
    <PolicyReasons reasons={policy.reasons} opHref={opHref} />
  </Flex>
);
