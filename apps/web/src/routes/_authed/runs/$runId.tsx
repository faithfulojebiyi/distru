import { createFileRoute } from '@tanstack/react-router';

import { RunDetailPage } from '../../../modules/runs/run-detail';

export const Route = createFileRoute('/_authed/runs/$runId')({
  component: RunRoute,
});

function RunRoute() {
  const { runId } = Route.useParams();
  return <RunDetailPage key={runId} runId={runId} />;
}
