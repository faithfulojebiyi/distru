import { createFileRoute } from '@tanstack/react-router';

import { Page } from '../../../modules/layout/components/page';
import { ProposalDetailView } from '../../../modules/proposals/components/proposal-detail';

export const Route = createFileRoute('/_authed/approvals/$proposalId')({
  component: ProposalPage,
});

function ProposalPage() {
  const { proposalId } = Route.useParams();
  return (
    <Page title="Proposal" description="Review every field this change writes before you decide.">
      <ProposalDetailView key={proposalId} proposalId={proposalId} />
    </Page>
  );
}
