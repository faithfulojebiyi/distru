import type { ReactNode } from 'react';
import { Box, Flex, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { Illustrations } from '@ops/ui/illustrations';
import { Button } from '@ops/ui/primitives/button';
import { Span } from '@ops/ui/primitives/text';

/** An empty list as an invitation: a line illustration, what is missing and what to do (carbonme empty state). */
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

/** A grey panel with a title row and an optional action on the right (clarkia's Panel). */
export const Panel = ({
  title,
  action,
  children,
  ...rest
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
} & Record<`data-${string}`, string>) => (
  <Flex
    as="section"
    direction="column"
    gap="3"
    p="4"
    rounded="xl"
    bg="brand.panel.2"
    fontSize="1.5"
    minW="0"
    {...rest}
  >
    <HStack justify="space-between" gap="3" minH="6">
      <Span fontWeight="600">{title}</Span>
      {action ? (
        <Span color="text.muted" fontSize="1">
          {action}
        </Span>
      ) : null}
    </HStack>
    {children}
  </Flex>
);

/** One stat card: a label with its icon, a big figure, and one line under it (clarkia's StatCard). */
export const StatCard = ({
  icon: Icon,
  label,
  value,
  note,
  tone,
  accent,
}: {
  icon: (typeof Icons)[keyof typeof Icons];
  label: string;
  value: ReactNode;
  note: ReactNode;
  tone?: 'muted';
  /** A coloured dot before the label, for the one card that needs attention. */
  accent?: string;
}) => (
  <Flex
    direction="column"
    gap="1.5"
    p="4"
    rounded="xl"
    bg="brand.panel.2"
    fontSize="1"
    minW="0"
    data-stat-card={label}
  >
    <HStack gap="1.5" color="text.muted">
      <Icon size={13} />
      {label}
      {accent ? (
        <styled.span ml="auto" w="1.5" h="1.5" rounded="full" bg={accent} />
      ) : null}
    </HStack>
    <styled.span
      color={tone === 'muted' ? 'text.placeholder' : 'text.app'}
      fontSize="6"
      fontWeight="600"
      lineHeight="1.2"
      fontVariantNumeric="tabular-nums"
      letterSpacing="-0.02em"
    >
      {value}
    </styled.span>
    <Span color="text.muted" truncate>
      {note}
    </Span>
  </Flex>
);
