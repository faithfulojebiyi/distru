import { QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';

import { getQueryClient } from './query';

export const QueryProvider = ({ children }: PropsWithChildren) => (
  // not useState: with no suspense boundary between here and a suspending
  // child, React would discard the client on the initial render
  <QueryClientProvider client={getQueryClient()}>
    {children}
  </QueryClientProvider>
);
