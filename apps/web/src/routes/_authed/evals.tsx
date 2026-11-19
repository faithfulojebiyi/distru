import { createFileRoute } from '@tanstack/react-router';

import { EvalsPage } from '../../modules/evals/evals-page';

export const Route = createFileRoute('/_authed/evals')({
  component: EvalsPage,
});
