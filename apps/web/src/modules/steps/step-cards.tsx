// Adapted from carbonme modules/chats/chat-connector-parts.tsx and the pending card of chat-connector-card.tsx (2b).
import type { ComponentProps, ReactNode } from 'react';
import { Box, Flex, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { IntegrationIcons } from '@ops/ui/icons/integrations';
import { Button } from '@ops/ui/primitives/button';
import { Link } from '@tanstack/react-router';

/** An app's mark, or its initial when the catalogue has no mark for it. */
export const AppMark = ({
  icon,
  name,
  size,
}: {
  icon: string;
  name: string;
  size: number;
}) => {
  if (icon in IntegrationIcons) {
    const Mark = IntegrationIcons[icon as keyof typeof IntegrationIcons];

    return <Mark width={size} height={size} />;
  }

  if (icon in Icons) {
    const Mark = Icons[icon as keyof typeof Icons];

    return <Mark size={size * 0.8} />;
  }

  return (
    <styled.span fontSize="1" fontWeight="600" color="chat.text2" aria-hidden>
      {name.charAt(0).toUpperCase()}
    </styled.span>
  );
};

/** The app's mark on a white tile lifted off the grey card; a dot marks a connection that needs attention. */
export const AppTile = ({
  icon,
  name,
  dim = false,
  dot = null,
}: {
  icon: string;
  name: string;
  dim?: boolean;
  dot?: 'amber' | null;
}) => (
  <Flex
    aria-hidden
    position="relative"
    align="center"
    justify="center"
    flexShrink="0"
    w="10"
    h="10"
    rounded="chatTileLg"
    bg="chat.item"
    shadow="chatChip"
    opacity={dim ? '0.6' : undefined}
  >
    <AppMark icon={icon} name={name} size={22} />
    {dot && (
      <styled.span
        position="absolute"
        right="-0.5"
        bottom="-0.5"
        w="2.5"
        h="2.5"
        rounded="full"
        bg="chat.dotAmber"
        boxShadow="0 0 0 2px {colors.background.app}"
      />
    )}
  </Flex>
);

/** A small tinted pill beside a card's title. */
export const CardBadge = ({
  tone = 'plain',
  children,
}: {
  tone?: 'plain' | 'amber' | 'green';
  children: ReactNode;
}) => (
  <styled.span
    display="inline-flex"
    alignItems="center"
    gap="1.5"
    h="18px"
    px="7px"
    rounded="full"
    fontSize="0.719"
    fontWeight="500"
    whiteSpace="nowrap"
    flexShrink="0"
    bg={BADGE_TONES[tone].bg}
    color={BADGE_TONES[tone].color}
  >
    {children}
  </styled.span>
);

const BADGE_TONES = {
  plain: { bg: 'brand.panel.5', color: 'chat.text2' },
  amber: { bg: 'status.warn.bg', color: 'status.warn.fg' },
  green: { bg: 'status.good.bg', color: 'status.good.fg' },
} as const;

/** The status dot inside a badge. */
export const BadgeDot = ({ tone }: { tone: 'amber' | 'green' }) => (
  <styled.span
    aria-hidden
    w="1.5"
    h="1.5"
    rounded="full"
    bg={tone === 'amber' ? 'chat.dotAmber' : 'chat.dotGreen'}
  />
);

/** A connector card: a grey panel with the app's tile, a title and why, then its body and buttons. */
export const ConnectorCardShell = ({
  label,
  tile,
  title,
  badge,
  subtitle,
  children,
  ...rest
}: {
  label: string;
  tile: ReactNode;
  title: string;
  badge?: ReactNode;
  subtitle: string;
  children: ReactNode;
} & Omit<ComponentProps<typeof Flex>, 'title'>) => (
  <Flex
    direction="column"
    gap="3"
    maxW="35rem"
    minW="0"
    px="4"
    py="3.5"
    rounded="chatCard"
    bg="brand.panel.3"
    role="group"
    aria-label={label}
    animation="chatRise"
    _motionReduce={{ animation: 'none' }}
    {...rest}
  >
    <HStack gap="3" alignItems="flex-start" minW="0">
      {tile}
      <Box minW="0" flex="1">
        <HStack gap="2" flexWrap="wrap">
          <styled.p fontSize="2" fontWeight="600" color="text.app">
            {title}
          </styled.p>
          {badge}
        </HStack>
        <styled.p mt="0.5" fontSize="1.5" color="chat.text2">
          {subtitle}
        </styled.p>
      </Box>
    </HStack>
    {children}
  </Flex>
);

const NOTICE_TONES = {
  info: { bg: 'chat.item', color: 'chat.text2', icon: 'chat.muted' },
  amber: { bg: 'status.warn.bg', color: 'status.warn.fg', icon: 'inherit' },
  error: { bg: 'status.bad.bg', color: 'status.bad.fg', icon: 'inherit' },
} as const;

/** A line of explanation inside a card: plain on white, a warning in amber, or an error in red. */
export const CardNotice = ({
  tone,
  icon,
  children,
  ...rest
}: {
  tone: keyof typeof NOTICE_TONES;
  icon: ReactNode;
  children: ReactNode;
} & ComponentProps<typeof HStack>) => (
  <HStack
    gap="2"
    alignItems="flex-start"
    px="3"
    py="2"
    rounded="chatWell"
    fontSize="1.5"
    bg={NOTICE_TONES[tone].bg}
    color={NOTICE_TONES[tone].color}
    {...rest}
  >
    <styled.span
      display="flex"
      mt="0.5"
      flexShrink="0"
      color={NOTICE_TONES[tone].icon}
    >
      {icon}
    </styled.span>
    <styled.span minW="0">{children}</styled.span>
  </HStack>
);

/** A status box inside a card: a spinner or icon, a line in medium weight and a quieter one under it. */
export const CardWait = ({
  icon,
  title,
  detail,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
}) => (
  <HStack
    gap="2.5"
    px="3"
    py="2.5"
    rounded="chatWell"
    bg="chat.item"
    role="status"
  >
    <styled.span display="flex" color="chat.muted" flexShrink="0">
      {icon}
    </styled.span>
    <Box flex="1" minW="0">
      <styled.p fontWeight="500" fontSize="1.5" color="text.app">
        {title}
      </styled.p>
      <styled.p fontSize="1.25" color="chat.muted">
        {detail}
      </styled.p>
    </Box>
  </HStack>
);

/** The card's buttons, with an optional note pushed to the right. */
export const CardFooter = ({
  note,
  children,
}: {
  note?: ReactNode;
  children: ReactNode;
}) => (
  <HStack gap="2" flexWrap="wrap">
    {children}
    {note && (
      <HStack
        gap="1.5"
        ml="auto"
        fontSize="1"
        color="chat.muted"
        data-card-note
      >
        {note}
      </HStack>
    )}
  </HStack>
);

/** The card's main action: the solid button of the Chat. */
export const PrimaryButton = (props: ComponentProps<typeof Button>) => (
  <Button
    size="sm"
    bg="chat.solid"
    color="chat.solidFg"
    _hover={{ bg: 'chat.solidHover' }}
    {...props}
  />
);

/** A quiet action beside the main one. */
export const QuietButton = (props: ComponentProps<typeof Button>) => (
  <Button
    size="sm"
    variant="ghost"
    color="chat.text2"
    _hover={{ bg: 'brand.panel.5' }}
    {...props}
  />
);

/** A grey action for a secondary step, such as showing the window again. */
export const SoftButton = (props: ComponentProps<typeof Button>) => (
  <Button
    size="sm"
    variant="ghost"
    bg="brand.panel.5"
    color="text.app"
    _hover={{ bg: 'brand.panel.8' }}
    {...props}
  />
);

/** A suspended run waits for a human: the 2b "Waiting for Notion…" card, with Open proposal in place of Show window. */
export const ApprovalWaitCard = ({
  proposalId,
  title,
  value,
}: {
  proposalId: string | null;
  title: string | null;
  value: string | null;
}) => (
  <ConnectorCardShell
    label="Waiting for approval"
    tile={<AppTile icon="checkCircle" name="Approval" dot="amber" />}
    title="Waiting for approval"
    badge={
      <CardBadge tone="amber">
        <BadgeDot tone="amber" />
        Needs approval
      </CardBadge>
    }
    subtitle={
      title
        ? `${title}${value ? ` · ${value}` : ''}`
        : 'The run paused with a proposal for a human approver.'
    }
    data-approval-wait=""
  >
    <CardWait
      icon={<Icons.loading size={14} />}
      title="Waiting for an approver…"
      detail="Nothing is written until someone with the approve scope decides. The run carries on by itself once they do."
    />
    {proposalId && (
      <CardFooter>
        <SoftButton asChild>
          <Link
            to="/approvals/$proposalId"
            params={{ proposalId }}
            data-open-proposal=""
          >
            <Icons.exportSquare size={14} />
            Open proposal
          </Link>
        </SoftButton>
      </CardFooter>
    )}
  </ConnectorCardShell>
);

/** A link under a step or an answer, as carbonme's workflow pill: an icon, a name, a detail and a caret. */
export const LinkPill = ({
  icon,
  name,
  detail,
  badge,
  ...link
}: {
  icon: ReactNode;
  name: string;
  detail?: string | null;
  badge?: ReactNode;
} & (
  | { to: '/runs/$runId'; params: { runId: string } }
  | { to: '/approvals/$proposalId'; params: { proposalId: string } }
)) => (
  <Link {...link} data-link-pill={link.to}>
    <HStack
      gap="2"
      minH="9"
      px="3"
      maxW="35rem"
      rounded="chatCard"
      bg="brand.panel.3"
      fontSize="1.5"
      minW="0"
      transition="background 120ms"
      _hover={{ bg: 'brand.panel.5' }}
    >
      <styled.span display="flex" color="chat.muted" flexShrink="0">
        {icon}
      </styled.span>
      <styled.span fontWeight="500" color="text.app" truncate minW="0">
        {name}
      </styled.span>
      {detail && (
        <styled.span color="chat.muted" truncate minW="0">
          {detail}
        </styled.span>
      )}
      {badge}
      <styled.span color="chat.faint" ml="auto" display="flex" flexShrink="0">
        <Icons.caretRight size={12} />
      </styled.span>
    </HStack>
  </Link>
);
