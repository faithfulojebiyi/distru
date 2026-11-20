import { createFileRoute, redirect } from '@tanstack/react-router';

import { CopilotChatPage } from '../../modules/copilot/copilot-page';
import { isChatId } from '../../modules/copilot/copilot-chats-data';

type Search = { q?: string };

export const Route = createFileRoute('/_authed/copilot/$threadId')({
  validateSearch: (search: Record<string, unknown>): Search => ({
    q: typeof search.q === 'string' && search.q.trim() ? search.q.slice(0, 4000) : undefined,
  }),
  beforeLoad: ({ params }) => {
    if (!isChatId(params.threadId)) throw redirect({ to: '/copilot' });
  },
  component: CopilotChat,
});

function CopilotChat() {
  const { threadId } = Route.useParams();
  const { q } = Route.useSearch();
  return <CopilotChatPage key={threadId} threadId={threadId} initialQuestion={q ?? null} />;
}
