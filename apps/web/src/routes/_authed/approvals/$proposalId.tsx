import { createFileRoute } from '@tanstack/react-router';

import { Page } from '../../../modules/layout/components/page';
import { ProposalDetailView } from '../../../modules/proposals/components/proposal-detail';
import { useProposal } from '../../../modules/proposals/proposals-api';

type Search = { event?: string };

export const Route = createFileRoute('/_authed/approvals/$proposalId')({
  validateSearch: (search: Record<string, unknown>): Search => ({
    event: typeof search.event === 'string' && search.event ? search.event : undefined,
  }),
  component: ProposalPage,
});

function ProposalPage() {
  const { proposalId } = Route.useParams();
  const { event } = Route.useSearch();
  const proposal = useProposal(proposalId);
  return (
    <Page
      title={proposal.data?.title ?? 'Proposal'}
      crumbs={[{ label: 'Approvals', to: '/approvals' }]}
      heading={false}
    >
      <ProposalDetailView key={proposalId} proposalId={proposalId} openEventId={event ?? null} />
    </Page>
  );
}
