import { createFileRoute } from '@tanstack/react-router';

import { Page } from '../../../modules/layout/components/page';
import { RunsList } from '../../../modules/runs/runs-page';
import { StartRunButton } from '../../../modules/runs/start-run-dialog';

export const Route = createFileRoute('/_authed/runs/')({
  component: () => (
    <Page
      title="Runs"
      description="Every restock run: its agents, tool calls, tokens, cost and the proposal it made."
      actions={<StartRunButton />}
    >
      <RunsList />
    </Page>
  ),
});
