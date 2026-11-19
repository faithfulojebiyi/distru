import { Flex, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { Span } from '@ops/ui/primitives/text';
import type {
  PolicyEvaluation,
  PolicyReason,
} from '../../../api/generated/opsAgentAPI.schemas';
import { PolicyBadge } from './badges';

const REASON_STYLES: Record<
  PolicyReason['outcome'],
  { icon: keyof typeof Icons; color: string; label: string }
> = {
  pass: { icon: 'checkCircle', color: 'palette.green.11', label: 'Pass' },
  allow: { icon: 'checkCircle', color: 'palette.green.11', label: 'Allows auto-approval' },
  needs_approval: { icon: 'warn', color: 'palette.amber.11', label: 'Needs approval' },
  deny: { icon: 'ban', color: 'text.error', label: 'Deny' },
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

/** Every policy rule's verdict, the ones that decided the outcome first. */
export const PolicyReasons = ({ reasons }: { reasons: readonly PolicyReason[] }) => (
  <styled.ul listStyle="none" m="0" p="0" display="flex" flexDirection="column" gap="1">
    {[...reasons]
      .sort((a, b) => ORDER[a.outcome] - ORDER[b.outcome])
      .map((reason, index) => {
        const style = REASON_STYLES[reason.outcome];
        const Icon = Icons[style.icon];
        return (
          <styled.li
            key={`${reason.rule}:${index}`}
            display="grid"
            gridTemplateColumns="1rem minmax(0, 1fr)"
            columnGap="2.5"
            px="3"
            py="2"
            rounded="lg"
            bg="background.app"
            data-policy-reason={reason.outcome}
          >
            <styled.span color={style.color} pt="0.5" title={style.label} aria-label={style.label}>
              <Icon size={14} />
            </styled.span>
            <Flex direction="column" gap="0.5" minW="0">
              <Span fontSize="1.5">{reason.message}</Span>
              <Span fontSize="1" color="text.muted">
                {ruleName(reason.rule)}
              </Span>
            </Flex>
          </styled.li>
        );
      })}
  </styled.ul>
);

export const PolicyPanel = ({ policy }: { policy: PolicyEvaluation }) => (
  <Flex direction="column" gap="3" p="4" rounded="xl" bg="brand.panel.2" data-testid="policy-panel">
    <HStack justify="space-between" gap="2">
      <Span fontWeight="600" fontSize="1.5">
        Policy checks
      </Span>
      <PolicyBadge outcome={policy.outcome} />
    </HStack>
    <PolicyReasons reasons={policy.reasons} />
  </Flex>
);
