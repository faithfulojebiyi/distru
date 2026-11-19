import { createFileRoute } from '@tanstack/react-router';

import { CopilotPage } from '../../modules/copilot/copilot-page';

type Search = { q?: string };

export const Route = createFileRoute('/_authed/copilot')({
  validateSearch: (search: Record<string, unknown>): Search => ({
    q: typeof search.q === 'string' && search.q.trim() ? search.q.slice(0, 4000) : undefined,
  }),
  component: Copilot,
});

function Copilot() {
  const { q } = Route.useSearch();
  return <CopilotPage initialQuestion={q ?? null} />;
}
