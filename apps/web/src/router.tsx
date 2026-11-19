import { createRouter } from '@tanstack/react-router';

import { routeTree } from './routeTree.gen';
import { ErrorPage, NotFoundPage } from '@ops/ui/blocks/status-page';

/** TanStack Start looks for `getRouter` on the router entry, not `createRouter` */
export const getRouter = () =>
  createRouter({
    routeTree,
    // preload on hover/focus so navigation feels instant in a dense grid app
    defaultPreload: 'intent',
    defaultStaleTime: 30_000,
    scrollRestoration: true,
    // Every route falls back to the same dead-end pages instead of a blank screen or a crash.
    defaultNotFoundComponent: () => <NotFoundPage />,
    defaultErrorComponent: ({ error, reset }) => (
      <ErrorPage error={error} reset={reset} />
    ),
  });

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
