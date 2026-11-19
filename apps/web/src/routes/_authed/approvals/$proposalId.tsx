import { createFileRoute } from '@tanstack/react-router';

import { Page } from '../../../modules/layout/components/page';
import { ProposalDetailView } from '../../../modules/proposals/components/proposal-detail';
import { useProposal } from '../../../modules/proposals/proposals-api';

export const Route = createFileRoute('/_authed/approvals/$proposalId')({
  component: ProposalPage,
});

function ProposalPage() {
  const { proposalId } = Route.useParams();
  const proposal = useProposal(proposalId);
  return (
    <Page
      title={proposal.data?.title ?? 'Proposal'}
      crumbs={[{ label: 'Approvals', to: '/approvals' }]}
      heading={false}
    >
      <ProposalDetailView key={proposalId} proposalId={proposalId} />
    </Page>
  );
}
