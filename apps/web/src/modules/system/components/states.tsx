import type { ReactNode } from 'react';
import { Box, Flex } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { Illustrations } from '@ops/ui/illustrations';
import { Button } from '@ops/ui/primitives/button';
import { Span } from '@ops/ui/primitives/text';

/** An empty list as an invitation: a line illustration, what is missing and what to do (carbonme
 * integrations/integration-empty-state.tsx with the kit's illustrations). */
export const EmptyState = ({
  illustration = 'task',
  title,
  hint,
  action,
  compact = false,
}: {
  illustration?: keyof typeof Illustrations;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) => {
  const Illustration = Illustrations[illustration];
  return (
    <Flex
      direction="column"
      align="center"
      gap="1"
      py={compact ? '6' : '12'}
      px="6"
      rounded="xl"
      bg="brand.panel.2"
      color="text.muted"
      textAlign="center"
      data-empty-state=""
    >
      <Illustration size={compact ? 56 : 80} />
      <Span mt="2" color="text.app" fontWeight="500" fontSize="1.5">
        {title}
      </Span>
      {hint ? (
        <Span fontSize="1" maxW="26rem">
          {hint}
        </Span>
      ) : null}
      {action ? <Box mt="3">{action}</Box> : null}
    </Flex>
  );
};

/** A failed load: what failed, and a way to try again. */
export const ErrorState = ({
  title,
  hint = 'Check that the agent server is running, then try again.',
  retry,
}: {
  title: string;
  hint?: string;
  retry?: () => void;
}) => (
  <Flex
    direction="column"
    align="center"
    gap="1"
    py="10"
    px="6"
    rounded="xl"
    bg="brand.panel.2"
    color="text.muted"
    textAlign="center"
    role="alert"
    data-error-state=""
  >
    <Illustrations.unplugged size={64} />
    <Span mt="2" color="text.app" fontWeight="500" fontSize="1.5">
      {title}
    </Span>
    <Span fontSize="1">{hint}</Span>
    {retry ? (
      <Button size="xs" variant="soft" mt="3" onClick={retry}>
        <Icons.refresh size={12} />
        Try again
      </Button>
    ) : null}
  </Flex>
);
