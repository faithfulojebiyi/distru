import { createFileRoute } from '@tanstack/react-router';

import { Page } from '../../modules/layout/components/page';

export const Route = createFileRoute('/_authed/settings')({
  component: () => <Page title="Settings" description="Distru connection, policy rules and MCP access." />,
});
