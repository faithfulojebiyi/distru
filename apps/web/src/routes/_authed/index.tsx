import { createFileRoute } from '@tanstack/react-router';

import { Page } from '../../modules/layout/components/page';
import { OverviewPage } from '../../modules/overview/overview-page';

export const Route = createFileRoute('/_authed/')({
  component: () => (
    <Page title="Overview" description="Proposals waiting, what the agents wrote today, and what changed.">
      <OverviewPage />
    </Page>
  ),
});
