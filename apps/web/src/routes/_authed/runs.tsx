import { createFileRoute } from '@tanstack/react-router';

import { Page } from '../../modules/layout/components/page';

export const Route = createFileRoute('/_authed/runs')({
  component: () => <Page title="Runs" description="Every agent run, step by step." />,
});
