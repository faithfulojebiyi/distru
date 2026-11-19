import { createFileRoute } from '@tanstack/react-router';

import { Page } from '../../modules/layout/components/page';

export const Route = createFileRoute('/_authed/copilot')({
  component: () => <Page title="Copilot" description="Ask about stock, vendors and orders, or start a restock run." />,
});
