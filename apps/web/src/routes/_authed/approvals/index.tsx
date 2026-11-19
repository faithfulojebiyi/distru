import { createFileRoute } from '@tanstack/react-router';

import { Page } from '../../../modules/layout/components/page';
import { ProposalInbox } from '../../../modules/proposals/components/proposal-inbox';
import {
  isInboxTab,
  type InboxTab,
} from '../../../modules/proposals/proposal-values';

type Search = { status?: InboxTab };

export const Route = createFileRoute('/_authed/approvals/')({
  validateSearch: (search: Record<string, unknown>): Search => ({
    status: isInboxTab(search.status) ? search.status : undefined,
  }),
  component: Approvals,
});

function Approvals() {
  const { status } = Route.useSearch();
  return (
    <Page
      title="Approvals"
      description="Proposed ERP changes, gated by policy. Review the diff, then approve or reject."
    >
      <ProposalInbox tab={status ?? 'pending'} />
    </Page>
  );
}
