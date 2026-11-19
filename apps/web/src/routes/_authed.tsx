import { css } from '@ops/ui/css';
import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';
import { useState } from 'react';

import { SidebarInset, SidebarProvider } from '@ops/ui/primitives/sidebar';
import { useIsMobile } from '@ops/ui/hooks/use-mobile';
import { authClient } from '../lib/auth-client';
import {
  clearSessionQueries,
  getQueryClient,
  setQueryScope,
} from '../lib/query';
import { AppSidebar } from '../modules/layout/components/app-sidebar';
import { MobileSidebarTrigger } from '../modules/layout/components/mobile-sidebar-trigger';
import { OfflineBanner } from '../modules/system/components/offline-banner';

export const Route = createFileRoute('/_authed')({
  ssr: false,
  beforeLoad: async ({ location }) => {
    const { data, unreachable } = await sessionWithRetry();
    // The server is down or restarting: keep the current screen (its queries retry and show inline states, the
    // offline banner explains) rather than bouncing to sign-in or the route error page.
    if (unreachable) return { user: null };
    if (!data) {
      clearSessionQueries(getQueryClient());
      throw redirect({ to: '/sign-in', search: { redirect: location.href } });
    }
    setQueryScope(getQueryClient(), data.user.id);
    return { user: data.user };
  },
  component: AuthedLayout,
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The session, retrying a few times (0.5s, 1s, 2s) when the server cannot be reached at all. */
async function sessionWithRetry() {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const { data, error } = await authClient.getSession();
      // better-fetch reports "no response" as an error with status 0 (or no status) rather than throwing.
      const noResponse = Boolean(error) && !error?.status;
      if (!noResponse) return { data, unreachable: false };
    } catch {
      // a thrown TypeError: Failed to fetch
    }
    if (attempt >= 3) return { data: null, unreachable: true };
    await wait(500 * 2 ** attempt);
  }
}

function AuthedLayout() {
  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [previousMobile, setPreviousMobile] = useState(isMobile);
  if (isMobile !== previousMobile) {
    setPreviousMobile(isMobile);
    if (isMobile) setSidebarOpen(false);
  }
  return (
    <SidebarProvider
      mobile="rail"
      open={sidebarOpen}
      onOpenChange={setSidebarOpen}
    >
      <div className={css({ display: 'flex', h: '100dvh', w: 'full' })}>
        <AppSidebar />
        <MobileSidebarTrigger />
        <SidebarInset>
          <OfflineBanner />
          <Outlet />
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
