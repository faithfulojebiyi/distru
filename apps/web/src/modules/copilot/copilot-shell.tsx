// Adapted from carbonme modules/chats/chat-shell.tsx (breadcrumb bar, scrolling conversation, composer band below).
import { Link } from '@tanstack/react-router';
import { Box, Flex, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { ComposerBand } from './copilot-composer';

/** `Copilot › title` in a page bar, the conversation scrolling beneath it, and the composer fixed below both. */
export const CopilotShell = ({
  title,
  children,
  composer,
  scrollerRef,
}: {
  title: string;
  children: React.ReactNode;
  composer: React.ReactNode;
  scrollerRef?: React.Ref<HTMLDivElement>;
}) => (
  <Flex direction="column" h="full" minH="0" bg="background.app">
    <HStack
      as="nav"
      aria-label="Breadcrumb"
      gap="1.5"
      fontSize="1.5"
      minW="0"
      h="11"
      flexShrink="0"
      borderBottomWidth="1px"
      borderColor="border.subtle"
      // Room on phones for the floating sidebar trigger.
      pl={{ base: '12', md: '6' }}
      pr={{ base: '4', md: '6' }}
    >
      <Link to="/copilot" style={{ flexShrink: 0 }}>
        <styled.span color="text.muted" _hover={{ color: 'text.app' }}>
          Copilot
        </styled.span>
      </Link>
      <styled.span color="text.muted" aria-hidden>
        <Icons.caretRight size={12} />
      </styled.span>
      <styled.h1
        color="text.app"
        fontWeight="500"
        truncate
        minW="0"
        aria-current="page"
        data-testid="chat-title"
      >
        {title}
      </styled.h1>
    </HStack>
    <Flex direction="column" flex="1" minH="0">
      <Box
        ref={scrollerRef}
        flex="1"
        minH="0"
        overflowY="auto"
        pos="relative"
        style={{ scrollbarGutter: 'stable' }}
        data-testid="chat-scroller"
      >
        <Box
          mx="auto"
          w="full"
          maxW="48rem"
          px={{ base: '4', md: '6' }}
          pt={{ base: '6', md: '10' }}
          pb="8"
        >
          {children}
        </Box>
      </Box>
      <ComposerBand>{composer}</ComposerBand>
    </Flex>
  </Flex>
);
