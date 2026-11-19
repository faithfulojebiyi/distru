import type { ReactNode } from 'react';
import { Box, Flex, HStack } from '@ops/ui/jsx';

import { Heading, Text } from '@ops/ui/primitives/text';

/** Every signed-in screen: a title row with optional actions over a scrolling body. */
export const Page = ({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children?: ReactNode;
}) => (
  <Flex direction="column" h="full" minH="0">
    <HStack
      borderBottomWidth="1px"
      borderColor="border.subtle"
      gap="4"
      justify="space-between"
      px={{ base: '4', md: '6' }}
      py="4"
    >
      <Box minW="0">
        <Heading as="h1" fontSize="4" fontWeight="600" letterSpacing="-0.01em">
          {title}
        </Heading>
        {description ? (
          <Text color="text.muted" fontSize="1" mt="0.5">
            {description}
          </Text>
        ) : null}
      </Box>
      {actions ? <HStack gap="2">{actions}</HStack> : null}
    </HStack>
    <Box flex="1" minH="0" overflowY="auto" px={{ base: '4', md: '6' }} py="5">
      {children}
    </Box>
  </Flex>
);
