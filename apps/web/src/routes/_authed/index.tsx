import { createFileRoute } from '@tanstack/react-router';

import { Page } from '../../modules/layout/components/page';

export const Route = createFileRoute('/_authed/')({
  component: () => <Page title="Overview" description="Stock at risk, proposals waiting and what the agents did today." />,
});
