import { createFileRoute } from '@tanstack/react-router';

import { Page } from '../../modules/layout/components/page';

export const Route = createFileRoute('/_authed/audit')({
  component: () => <Page title="Audit log" description="Every write and decision, in order." />,
});
