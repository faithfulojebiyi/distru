// Built on carbonme modules/settings/settings-page.tsx (SettingsPage + SettingsPanel); the reasons list is the
// Approvals policy panel.
import { Link } from '@tanstack/react-router';
import { Flex, HStack, styled } from '@ops/ui/jsx';

import { Skeleton } from '@ops/ui/primitives/skeleton';
import { PolicyReasons } from '../proposals/components/policy-panel';
import { PolicyBadge } from '../proposals/components/badges';
import { formatDateTime } from '../proposals/proposal-values';
import { useProposal, useProposals } from '../proposals/proposals-api';
import { SettingsPage, SettingsPanel } from './settings-page';

/** The newest proposal's evaluation: every configured rule reports on every proposal, so this lists them all. */
const LatestEvaluation = ({ proposalId }: { proposalId: string }) => {
  const proposal = useProposal(proposalId);

  if (proposal.isPending) return <Skeleton h="40" rounded="lg" />;

  if (!proposal.data)
    return (
      <styled.p color="text.muted" fontSize="1.5">
        Could not load the latest proposal.
      </styled.p>
    );

  return (
    <Flex direction="column" gap="3">
      <HStack gap="2" fontSize="1" color="text.muted" flexWrap="wrap">
        <span>Applied to</span>
        <Link to="/approvals/$proposalId" params={{ proposalId }}>
          <styled.span color="text.app" fontWeight="500" _hover={{ textDecoration: 'underline' }}>
            {proposal.data.title ?? 'the latest proposal'}
          </styled.span>
        </Link>
        <span>· {formatDateTime(proposal.data.createdAt)}</span>
        <PolicyBadge outcome={proposal.data.policy.outcome} />
      </HStack>
      <PolicyReasons reasons={proposal.data.policy.reasons} />
    </Flex>
  );
};

/** Settings → Policy rules: read-only until the agent server exposes the rule set. */
export const PolicyPage = () => {
  const proposals = useProposals();
  const latest = proposals.data?.[0];

  return (
    <SettingsPage
      title="Policy rules"
      description="Deterministic rules the harness runs on every proposal before a human sees it. Agents cannot change them."
    >
      <SettingsPanel
        title="Rules in force"
        description="As evaluated on the newest proposal. Editing rules here needs a policy API on the agent server; for now they are seeded in the database."
        data-policy-rules=""
      >
        {proposals.isPending ? (
          <Skeleton h="40" rounded="lg" />
        ) : latest ? (
          <LatestEvaluation proposalId={latest.id} />
        ) : (
          <styled.p color="text.muted" fontSize="1.5">
            No proposals yet. Start a restock run and the rules show here once
            the first proposal is evaluated.
          </styled.p>
        )}
      </SettingsPanel>
    </SettingsPage>
  );
};
