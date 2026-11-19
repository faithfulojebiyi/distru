import { createFileRoute } from '@tanstack/react-router';

import { OverviewPage } from '../../modules/overview/overview-page';

export const Route = createFileRoute('/_authed/')({
  component: OverviewPage,
});
