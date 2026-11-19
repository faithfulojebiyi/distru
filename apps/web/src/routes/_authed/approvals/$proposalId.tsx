import { createFileRoute } from '@tanstack/react-router';
import { Flex } from '@ops/ui/jsx';

import { PageBar } from '../../../modules/layout/components/page';
import {
  PROPOSAL_TABS,
  ProposalDetailView,
  SIDE_TABS,
  type ProposalSearch,
} from '../../../modules/proposals/components/proposal-detail';
import { useProposal } from '../../../modules/proposals/proposals-api';
import { crumbTitle } from '../../../modules/proposals/proposal-record';

const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined =>
  values.find((item) => item === value);

export const Route = createFileRoute('/_authed/approvals/$proposalId')({
  validateSearch: (search: Record<string, unknown>): ProposalSearch => ({
    event: typeof search.event === 'string' && search.event ? search.event : undefined,
    tab: oneOf(PROPOSAL_TABS, search.tab),
    side: oneOf(SIDE_TABS, search.side),
  }),
  component: ProposalPage,
});

/** The breadcrumb bar, then the full-height record page (no page scroll: each pane scrolls on its own). */
function ProposalPage() {
  const { proposalId } = Route.useParams();
  const search = Route.useSearch();
  const proposal = useProposal(proposalId);
  return (
    <Flex direction="column" h="full" minH="0" bg="background.app">
      <PageBar title={proposal.data ? crumbTitle(proposal.data) : 'Proposal'} crumbs={[{ label: 'Approvals', to: '/approvals' }]} />
      <Flex direction="column" flex="1" minH="0">
        <ProposalDetailView key={proposalId} proposalId={proposalId} search={search} />
      </Flex>
    </Flex>
  );
}
