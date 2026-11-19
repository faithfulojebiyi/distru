import type { ReactNode } from 'react';
import { cva } from '@ops/ui/css';
import { Box, Flex, HStack, styled } from '@ops/ui/jsx';
import { BrandMark } from '@ops/ui/icons/brand-mark';
import { Heading, Span, Text } from '@ops/ui/primitives/text';

import { LEDGER_LINES, WELCOME_TASKS } from './constants';
import type { WelcomeTask as WelcomeTaskRow } from './types';

export type AuthShellProps = {
  /** the form column */
  children: ReactNode;
  /** the right pane: the welcome panel on sign-in, a product preview in onboarding */
  aside?: ReactNode;
  /** top right: a short prompt and a link to the other auth page, e.g. "New here? Sign up" */
  switchTo?: ReactNode;
  /** onboarding only — a way out of a half-finished account */
  onSignOut?: () => void;
  /** auth forms take a narrow column; onboarding and workspace setup a wider one */
  width?: 'narrow' | 'wide';
};

/**
 * The logo and a contextual switch on top, the form centred in the left column, and the aside filling the right.
 * Every auth and onboarding screen is this shell with different contents, so nothing moves between steps.
 */
export const AuthShell = ({
  children,
  aside,
  switchTo,
  onSignOut,
  width = 'narrow',
}: AuthShellProps) => (
  <styled.div
    bg="background.app"
    display="grid"
    gap="3"
    gridTemplateColumns={{ base: '1fr', lg: 'minmax(0, 1fr) minmax(0, 1fr)' }}
    minH="100dvh"
    p={{ base: '0', lg: '3' }}
  >
    <Flex direction="column" minW="0" px={{ base: '4', lg: '4' }} py="3">
      <HStack h="9" justify="space-between" gap="3">
        <Heading as="h1" fontSize="2" fontWeight="600" letterSpacing="-0.01em">
          <Span alignItems="center" display="inline-flex" gap="2">
            <BrandMark size="1.375rem" />
            OPS AGENT
          </Span>
        </Heading>
        <HStack color="text.muted" fontSize="1.5" gap="2.5">
          {switchTo}
        </HStack>
      </HStack>
      <Flex align="center" flex="1" justify="center" py="10">
        <Box maxW={width === 'narrow' ? '21.25rem' : '26.25rem'} w="full">
          {children}
        </Box>
      </Flex>
      <HStack
        color="text.placeholder"
        fontSize="1"
        h="7"
        justify="space-between"
      >
        <Span>Portfolio project · not affiliated with Distru</Span>
        {onSignOut ? (
          <Text
            asChild
            color="text.muted"
            fontSize="1"
            textDecoration="underline"
          >
            <button onClick={onSignOut} type="button">
              Sign out
            </button>
          </Text>
        ) : null}
      </HStack>
    </Flex>
    {aside ? (
      <Flex display={{ base: 'none', lg: 'flex' }} minW="0">
        {aside}
      </Flex>
    ) : null}
  </styled.div>
);

/** The status dot on a welcome row; a working row pulses. */
const statusDot = cva({
  base: { h: '0.4375rem', rounded: 'full', w: '0.4375rem' },
  variants: {
    tone: {
      done: { bg: 'brand.success.9' },
      working: {
        animation: 'pulse 1.2s ease-in-out infinite',
        bg: 'brand.warning.9',
      },
      needs: { bg: 'brand.error.9' },
    },
  },
});

/** One row of the welcome panel: an at-risk item, what the agents are doing about it, and where it stands. */
const WelcomeTask = ({
  code,
  title,
  detail,
  tone,
  status,
  typing,
  delay,
}: WelcomeTaskRow & { delay: string }) => (
  <styled.div
    alignItems="center"
    animation="slideUpAndFade 0.5s ease both"
    bg="rgba(255,255,255,0.72)"
    backdropFilter="blur(8px)"
    display="grid"
    gap="3"
    gridTemplateColumns="2.75rem minmax(0, 1fr) auto"
    px="3.5"
    py="3"
    rounded="xl"
    style={{ animationDelay: delay }}
  >
    <Span color="text.muted" fontFamily="mono" fontSize="1" fontWeight="600">
      {code}
    </Span>
    <Flex direction="column" minW="0">
      <Span fontSize="1.5" fontWeight="500" truncate>
        {title}
      </Span>
      <Span color="text.muted" fontSize="1" truncate>
        {detail}
        {typing ? (
          <styled.span animation="caretBlink 1s steps(1) infinite" ml="0.5">
            |
          </styled.span>
        ) : null}
      </Span>
    </Flex>
    <HStack color="text.muted" fontSize="1" gap="1.5">
      <span className={statusDot({ tone })} />
      {status}
    </HStack>
  </styled.div>
);

/** The right pane on sign-in (light mode only): what Ops Agent does, over faint ERP records, with restock work rising in. */
export const WelcomeAside = () => (
  <Flex
    background="linear-gradient(180deg, #f5f6f7 0%, #edf1f6 48%, #d7e3f3 100%)"
    direction="column"
    overflow="hidden"
    p="10"
    position="relative"
    rounded="2xl"
    w="full"
  >
    <Heading
      as="h2"
      fontSize="7"
      fontWeight="600"
      letterSpacing="-0.025em"
      lineHeight="1.15"
      maxW="28rem"
    >
      Agents propose. People approve.
    </Heading>
    <Text color="text.muted" fontSize="1.5" maxW="26rem" mt="3">
      A multi-agent system watches your cannabis ERP, finds stock about to run
      out and drafts purchase orders as reviewable diffs. Nothing is written
      until an approver signs off, and every write is checked, retry-safe and
      audited.
    </Text>
    <styled.pre
      aria-hidden="true"
      color="#0a12170d"
      fontFamily="mono"
      fontSize="1"
      left="10"
      lineHeight="1.9"
      m="0"
      pointerEvents="none"
      position="absolute"
      right="-10"
      top="13rem"
      userSelect="none"
    >
      {LEDGER_LINES.join('\n')}
    </styled.pre>
    <Flex direction="column" gap="2" mt="auto" position="relative">
      {WELCOME_TASKS.map((task, index) => (
        <WelcomeTask key={task.title} delay={`${index * 0.15}s`} {...task} />
      ))}
    </Flex>
  </Flex>
);
