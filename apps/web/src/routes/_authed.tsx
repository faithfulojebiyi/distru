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

export const Route = createFileRoute('/_authed')({
  ssr: false,
  beforeLoad: async ({ location }) => {
    const { data } = await authClient.getSession();
    if (!data) {
      clearSessionQueries(getQueryClient());
      throw redirect({ to: '/sign-in', search: { redirect: location.href } });
    }
    setQueryScope(getQueryClient(), data.user.id);
    return { user: data.user };
  },
  component: AuthedLayout,
});

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
          <Outlet />
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
