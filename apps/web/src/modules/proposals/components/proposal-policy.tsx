// The Policy checks tab of the proposal record page: the existing Approvals policy panel (policy-panel.tsx: a grey
// rounded panel, "Policy checks" + outcome pill, each verdict as a white row with its icon, message and rule label),
// full width, with an "Edit policy rules" link for approvers and repeated op verdicts collapsed into one row.
import { Link } from '@tanstack/react-router';
import { Box, styled } from '@ops/ui/jsx';

import { Span } from '@ops/ui/primitives/text';
import type { ProposalDetail } from '../../../api/generated/opsAgentAPI.schemas';
import { useMe } from '../../session/session-api';
import { PolicyPanel } from './policy-panel';

/** The tab's count tint: red if a rule denied, amber if one asked for a human. */
export const policyTone = (proposal: ProposalDetail): 'bad' | 'warn' | null =>
  proposal.policy.reasons.some((reason) => reason.outcome === 'deny')
    ? 'bad'
    : proposal.policy.reasons.some((reason) => reason.outcome === 'needs_approval')
      ? 'warn'
      : null;

export const ProposalPolicy = ({ proposal, openOp }: { proposal: ProposalDetail; openOp: (index: number) => void }) => {
  const me = useMe();
  return (
    <Box px="5" py="5" data-testid="proposal-policy">
      <PolicyPanel
        policy={proposal.policy}
        action={
          me.data?.canApprove ? (
            <Link to="/settings/policy" data-edit-policy="">
              <Span fontSize="1" color="text.muted" _hover={{ color: 'text.app' }}>
                Edit policy rules
              </Span>
            </Link>
          ) : null
        }
        opHref={(index) => (
          <styled.button type="button" onClick={() => openOp(index)} textDecoration="underline" textUnderlineOffset="2px" cursor="pointer" data-policy-op={index}>
            #{index + 1}
          </styled.button>
        )}
      />
    </Box>
  );
};
