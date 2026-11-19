import { Suspense, type ReactNode } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { domAnimation, LazyMotion } from 'motion/react';

import { QueryProvider } from '../../../lib/query-provider';
import { ThemeProvider } from '@ops/ui/primitives/theme/theme-provider';
import { Toaster } from '@ops/ui/primitives/toast/toaster';

/** Sign-in and sign-up are designed for light mode only, whatever the viewer's theme. */
const LIGHT_ONLY_PATHS = new Set(['/sign-in', '/sign-up']);

/**
 * Mounted inside the document body because next-themes injects a script and
 * cannot wrap the root html element without breaking hydration.
 */
export const AppProviders = ({ children }: { children: ReactNode }) => {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  return (
    <Suspense fallback={null}>
      <LazyMotion features={domAnimation}>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          disableTransitionOnChange
          enableSystem
          forcedTheme={LIGHT_ONLY_PATHS.has(pathname) ? 'light' : undefined}
          storageKey="ops:theme"
          themes={['light', 'dark']}
        >
          <QueryProvider>{children}</QueryProvider>
          <Toaster />
        </ThemeProvider>
      </LazyMotion>
    </Suspense>
  );
};
