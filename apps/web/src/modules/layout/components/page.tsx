// Adapted from carbonme modules/settings/settings-page.tsx and modules/chats/chat-shell.tsx: a breadcrumb bar
// (`Approvals › Restock Blue Dream…`) over a scrolling column whose heading sits in the content, no bordered header.
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Box, Flex, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { Span } from '@ops/ui/primitives/text';

export type Crumb = { label: string; to: '/approvals' | '/runs' | '/audit' | '/settings/connectors' };

const WIDTHS = { form: '52rem', admin: '60rem', wide: '72rem', full: '80rem' } as const;

/** The bar every signed-in page starts with: its trail, then where you are, with actions on the right. */
export const PageBar = ({
  title,
  crumbs = [],
  actions,
}: {
  title: string;
  crumbs?: Crumb[];
  actions?: ReactNode;
}) => (
  <HStack
    as="nav"
    aria-label="Breadcrumb"
    borderBottomWidth="1px"
    borderColor="border.subtle"
    flexShrink="0"
    fontSize="1.5"
    gap="1.5"
    h="11"
    minW="0"
    // Room on phones for the floating sidebar trigger.
    pl={{ base: '12', md: '6' }}
    pr={{ base: '4', md: '6' }}
  >
    {crumbs.map((crumb) => (
      <HStack key={crumb.to} gap="1.5" flexShrink="0">
        <Link to={crumb.to}>
          <styled.span color="text.muted" _hover={{ color: 'text.app' }}>
            {crumb.label}
          </styled.span>
        </Link>
        <styled.span color="text.muted" aria-hidden>
          <Icons.caretRight size={12} />
        </styled.span>
      </HStack>
    ))}
    <styled.h1 fontWeight="500" truncate minW="0" aria-current="page">
      {title}
    </styled.h1>
    {actions ? (
      <HStack gap="2" ml="auto" flexShrink="0">
        {actions}
      </HStack>
    ) : null}
  </HStack>
);

/** Every signed-in screen: the breadcrumb bar, then the page's heading and body in one centred column. */
export const Page = ({
  title,
  crumb,
  crumbs,
  description,
  actions,
  heading = true,
  width = 'full',
  children,
}: {
  title: string;
  /** What the bar calls the page when it differs from the heading. */
  crumb?: string;
  crumbs?: Crumb[];
  description?: string;
  /** Beside the heading, as carbonme's page actions. */
  actions?: ReactNode;
  /** False when the body draws its own heading (a proposal's title and status). */
  heading?: boolean;
  width?: keyof typeof WIDTHS;
  children?: ReactNode;
}) => (
  <Flex direction="column" h="full" minH="0" bg="background.app">
    <PageBar title={crumb ?? title} crumbs={crumbs} />
    <Box flex="1" minH="0" overflowY="auto" w="full" style={{ scrollbarGutter: 'stable' }}>
      <Flex
        direction="column"
        gap="6"
        maxW={WIDTHS[width]}
        mx="auto"
        px={{ base: '4', md: '8' }}
        pt="8"
        pb="24"
      >
        {heading ? (
          <Flex justify="space-between" align="flex-start" gap="4" flexWrap="wrap">
            <Flex direction="column" gap="1" minW="0">
              <styled.h2 fontSize="3" fontWeight="600" data-page-title="">
                {title}
              </styled.h2>
              {description ? (
                <Span color="text.muted" fontSize="1.5">
                  {description}
                </Span>
              ) : null}
            </Flex>
            {actions ? <HStack gap="2">{actions}</HStack> : null}
          </Flex>
        ) : null}
        {children}
      </Flex>
    </Box>
  </Flex>
);
