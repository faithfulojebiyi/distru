import type { QueryClient } from '@tanstack/react-query';

import { clearSessionQueries, getQueryClient } from './query';

type SessionExpiryDependencies = {
  getClient: () => QueryClient;
  clearQueries: (client: QueryClient) => void;
  getCurrentLocation: () => string;
  redirect: (target: string) => void;
};

export const createSessionExpiryHandler = (
  dependencies: SessionExpiryDependencies,
) => {
  let redirecting = false;

  return () => {
    if (redirecting) return;
    redirecting = true;

    dependencies.clearQueries(dependencies.getClient());
    const redirect = dependencies.getCurrentLocation();
    const search = new URLSearchParams({ redirect });
    dependencies.redirect(`/sign-in?${search.toString()}`);
  };
};

export const handleSessionExpiry = () => {
  if (typeof window === 'undefined') return;

  browserSessionExpiryHandler();
};

const browserSessionExpiryHandler = createSessionExpiryHandler({
  getClient: getQueryClient,
  clearQueries: clearSessionQueries,
  getCurrentLocation: () =>
    `${window.location.pathname}${window.location.search}${window.location.hash}`,
  redirect: (target) => window.location.replace(target),
});
