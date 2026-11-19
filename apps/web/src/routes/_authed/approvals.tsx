import { createFileRoute } from '@tanstack/react-router';

import { Page } from '../../modules/layout/components/page';

export const Route = createFileRoute('/_authed/approvals')({
  component: () => <Page title="Approvals" description="Proposed ERP changes waiting for a decision." />,
});
