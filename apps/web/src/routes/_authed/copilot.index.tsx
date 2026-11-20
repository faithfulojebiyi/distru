import { createFileRoute } from '@tanstack/react-router';

import { NewCopilotPage } from '../../modules/copilot/copilot-page';

type Search = { q?: string };

export const Route = createFileRoute('/_authed/copilot/')({
  validateSearch: (search: Record<string, unknown>): Search => ({
    q: typeof search.q === 'string' && search.q.trim() ? search.q.slice(0, 4000) : undefined,
  }),
  component: NewCopilot,
});

function NewCopilot() {
  const { q } = Route.useSearch();
  return <NewCopilotPage initialQuestion={q ?? null} />;
}
