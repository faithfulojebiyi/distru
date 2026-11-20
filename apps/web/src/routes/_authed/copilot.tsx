import { Outlet, createFileRoute } from '@tanstack/react-router';

/** Copilot chats: /copilot (a new chat) and /copilot/$threadId (one chat). */
export const Route = createFileRoute('/_authed/copilot')({
  component: Outlet,
});
