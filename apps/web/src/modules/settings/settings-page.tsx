// Adapted from carbonme modules/settings/settings-page.tsx.
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Box, Flex, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { Span } from '@ops/ui/primitives/text';

/** A Settings section: its breadcrumb, a title with one line of purpose, then the section's panels. */
export const SettingsPage = ({
  title,
  description,
  children,
  trail = [],
  heading,
  width = 'form',
}: {
  title: string;
  description: string;
  children: ReactNode;
  /** Pages between Settings and this one in the breadcrumb. */
  trail?: { label: string; to: string; search?: Record<string, never> }[];
  /** Replaces the default title block, for pages with their own header. */
  heading?: ReactNode;
  /** Forms take the narrow column, admin pages a shared 960px one, and Usage's tables and charts the widest. */
  width?: 'form' | 'admin' | 'wide';
}) => (
  <Flex direction="column" h="full" minH="0" bg="background.app">
    <HStack
      aria-label="Breadcrumb"
      as="nav"
      borderBottomWidth="1px"
      borderColor="border.subtle"
      flexShrink="0"
      fontSize="1.5"
      gap="1.5"
      h="11"
      px="4"
    >
      <Link to="/settings/connectors">
        <styled.span color="text.muted" _hover={{ color: 'text.app' }}>
          Settings
        </styled.span>
      </Link>
      {trail.map((step) => (
        <HStack key={step.to} gap="1.5">
          <styled.span color="text.muted">
            <Icons.caretRight size={12} />
          </styled.span>
          <Link to={step.to as '/settings/connectors'} search={step.search}>
            <styled.span color="text.muted" _hover={{ color: 'text.app' }}>
              {step.label}
            </styled.span>
          </Link>
        </HStack>
      ))}
      <styled.span color="text.muted">
        <Icons.caretRight size={12} />
      </styled.span>
      <styled.span fontWeight="500">{title}</styled.span>
    </HStack>

    <Box flex="1" overflowY="auto" w="full">
      <Flex
        direction="column"
        gap="6"
        maxW={
          width === 'wide' ? '70rem' : width === 'admin' ? '60rem' : '52rem'
        }
        mx="auto"
        px={{ base: '4', md: '8' }}
        pt="8"
        pb="24"
      >
        {heading ?? (
          <Flex direction="column" gap="1">
            <styled.h1 fontSize="3" fontWeight="600" data-settings-title="">
              {title}
            </styled.h1>
            <Span color="text.muted" fontSize="1.5">
              {description}
            </Span>
          </Flex>
        )}

        {children}
      </Flex>
    </Box>
  </Flex>
);

/** One grey panel of related settings, titled like the reference's Invite Members block. */
export const SettingsPanel = ({
  title,
  description,
  children,
  ...data
}: {
  title: string;
  description?: string;
  children: ReactNode;
} & Record<`data-${string}`, string>) => (
  <Flex
    as="section"
    aria-label={title}
    direction="column"
    gap="4"
    p="5"
    rounded="xl"
    bg="brand.panel.2"
    fontSize="1"
    {...data}
  >
    <Flex direction="column" gap="0.5">
      <styled.h2 fontSize="1.5" fontWeight="600">
        {title}
      </styled.h2>
      {description && <Span color="text.muted">{description}</Span>}
    </Flex>

    {children}
  </Flex>
);

