import { createFileRoute } from '@tanstack/react-router';

import { Page } from '../../modules/layout/components/page';

export const Route = createFileRoute('/_authed/evals')({
  component: () => <Page title="Evals" description="Scenario scores for the agent system." />,
});
