import { Suspense, type ReactNode } from 'react';
import { domAnimation, LazyMotion } from 'motion/react';

import { QueryProvider } from '../../../lib/query-provider';
import { ThemeProvider } from '@ops/ui/primitives/theme/theme-provider';
import { Toaster } from '@ops/ui/primitives/toast/toaster';

/**
 * Mounted inside the document body because next-themes injects a script and
 * cannot wrap the root html element without breaking hydration.
 */
export const AppProviders = ({ children }: { children: ReactNode }) => (
  <Suspense fallback={null}>
    <LazyMotion features={domAnimation}>
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        disableTransitionOnChange
        enableSystem
        storageKey="ops:theme"
        themes={['light', 'dark']}
      >
        <QueryProvider>{children}</QueryProvider>
        <Toaster />
      </ThemeProvider>
    </LazyMotion>
  </Suspense>
);
