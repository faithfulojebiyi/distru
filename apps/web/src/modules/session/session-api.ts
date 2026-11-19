import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';

import { getHealth } from '../../api/generated/system/system';
import { getMe } from '../../api/generated/auth/auth';
import type { Me } from '../../api/generated/opsAgentAPI.schemas';
import { getQueryScope } from '../../lib/query';
import { canApprove } from '../../lib/auth-client';

/** Every session query key, built here so invalidation always matches by prefix. */
export const sessionKeys = {
  all: ['session'] as const,
  me: (scope: string) => ['session', 'me', scope] as const,
  health: ['session', 'health'] as const,
};

/**
 * The signed-in user as the agent server sees them, role included. A 401
 * never toasts: the mutator already sends the person back to sign-in.
 */
export const useMe = () => {
  const client = useQueryClient();

  return useQuery({
    queryKey: sessionKeys.me(getQueryScope(client)),
    queryFn: ({ signal }) => getMe({ signal }),
    staleTime: 5 * 60_000,
    select: (me: Me) => ({ ...me, canApprove: canApprove(me.role) }),
  });
};

/** Whether the agent server is up; renders its own offline state, so no toast. */
export const useAgentHealth = () =>
  useQuery({
    queryKey: sessionKeys.health,
    queryFn: ({ signal }) => getHealth({ signal }),
    // Every 30s while up; every 5s while down, so the offline banner clears soon after a restart.
    refetchInterval: (query) => (query.state.status === 'error' ? 5_000 : 30_000),
    retry: false,
    meta: { suppressErrorToast: true },
  });

/** Refetch the user after something changes who they are, such as a role change. */
export const invalidateMe = (client: QueryClient) =>
  client.invalidateQueries({ queryKey: [...sessionKeys.all, 'me'] });
