// The app-wide "can't reach the server" strip. Its look is carbonme modules/chats/chat-tool-runs.tsx AwaitingApproval
// (an amber-tinted strip with a dot and one line), full width at the top of the content area; it polls /api/health
// every 5s while down and hides itself on recovery.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { HStack, styled } from '@ops/ui/jsx';

import { Button } from '@ops/ui/primitives/button';
import { useAgentHealth } from '../../session/session-api';

export const OfflineBanner = () => {
  const health = useAgentHealth();
  const client = useQueryClient();
  const wasDown = useRef(false);
  // Back up: refetch every query that gave up while the server was unreachable, so screens recover by themselves.
  useEffect(() => {
    if (health.isError) wasDown.current = true;
    else if (health.isSuccess && wasDown.current) {
      wasDown.current = false;
      void client.refetchQueries({ predicate: (query) => query.state.status === 'error' });
    }
  }, [health.isError, health.isSuccess, client]);
  // Only after a failed check (a slow first check is not "offline").
  if (!health.isError) return null;
  return (
    <HStack
      gap="2.5"
      px="4"
      h="9"
      flexShrink="0"
      bg={{ base: 'palette.orange.3', _dark: 'palette.amber.3' }}
      color="palette.amber.11"
      fontSize="1.5"
      fontWeight="500"
      role="status"
      aria-live="polite"
      data-offline-banner=""
    >
      <styled.span aria-hidden w="1.5" h="1.5" rounded="full" bg="palette.amber.9" flexShrink="0" />
      <styled.span flex="1" minW="0" truncate>
        Can’t reach the agent server. Retrying every few seconds; pages refresh when it is back.
      </styled.span>
      <Button size="xs" variant="ghost" onClick={() => void health.refetch()} disabled={health.isFetching}>
        Retry now
      </Button>
    </HStack>
  );
};
