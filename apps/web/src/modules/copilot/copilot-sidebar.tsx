// Copied from carbonme modules/chats/chat-sidebar-list.tsx (ChatRowIcon, ChatRow: a Link with the bubble — filled
// for the open chat — the title and the ··· actions menu; the "+" to start a new chat), as a section of the main
// sidebar (carbonme's workflow-sidebar-tree section look) instead of a tab.
import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { css } from '@ops/ui/css';
import { Box, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { Button } from '@ops/ui/primitives/button';
import { useMe } from '../session/session-api';
import { SidebarMore, SidebarSection } from '../layout/components/sidebar-section';
import { useBackfillChatTitles, useCopilotChats } from './copilot-api';
import { ChatActionsMenu, useChatActions, type ChatActions } from './copilot-chat-actions';
import { chatTitle, type CopilotChat } from './copilot-chats-data';

/** Rows shown before "Show all". */
export const CHATS_SHOWN = 8;

const ChatRow = ({ item, active, actions }: { item: CopilotChat; active: boolean; actions: ChatActions }) => (
  <HStack
    gap="0"
    h="8"
    pr="1"
    rounded="md"
    bg={active ? 'brand.panel.10' : 'transparent'}
    _hover={{ bg: 'brand.panel.6' }}
    aria-current={active ? 'page' : undefined}
    data-chat-row={item.id}
  >
    <Link
      to="/copilot/$threadId"
      params={{ threadId: item.id }}
      title={chatTitle(item.title)}
      className={css({
        display: 'flex',
        alignItems: 'center',
        gap: '2',
        flex: '1',
        minW: '0',
        h: 'full',
        pl: '2',
        rounded: 'md',
        _focusVisible: { outline: '2px solid', outlineColor: 'border.focused', outlineOffset: '-2px' },
      })}
    >
      <styled.span
        display="flex"
        flexShrink="0"
        color={active ? 'text.app' : 'text.muted'}
        data-icon={active ? 'filled' : 'outline'}
      >
        <Icons.chatBubble size={14} fill={active ? 'currentColor' : 'none'} />
      </styled.span>
      <styled.span
        fontSize="1"
        flex="1"
        minW="0"
        truncate
        fontWeight={active ? '500' : '400'}
        color={item.title?.trim() ? 'text.app' : 'text.muted'}
      >
        {chatTitle(item.title)}
      </styled.span>
    </Link>
    <ChatActionsMenu item={item} actions={actions} side="right" />
  </HStack>
);

/** The sidebar's Chats: the user's own Copilot chats, newest first, the open one highlighted. */
export const ChatsSidebarSection = ({ pathname }: { pathname: string }) => {
  const me = useMe();
  const chats = useCopilotChats(me.data?.id);
  useBackfillChatTitles(chats.data);
  const navigate = useNavigate();
  const [all, setAll] = useState(false);
  const actions = useChatActions({
    // Deleting the open chat leaves its page.
    deleted: (item) => {
      if (pathname === `/copilot/${item.id}`) void navigate({ to: '/copilot' });
    },
  });
  const items = chats.data ?? [];
  const shown = all ? items : items.slice(0, CHATS_SHOWN);
  return (
    <SidebarSection
      id="chats"
      label="Chats"
      action={
        <Button asChild aria-label="New chat" title="New chat" size="icon" variant="ghost" flexShrink="0" h="6" w="6">
          <Link to="/copilot" data-new-chat-link="">
            <Icons.add size={14} />
          </Link>
        </Button>
      }
    >
      {shown.map((item) => (
        <ChatRow key={item.id} item={item} active={pathname === `/copilot/${item.id}`} actions={actions} />
      ))}
      {items.length > CHATS_SHOWN && (
        <SidebarMore type="button" onClick={() => setAll(!all)} aria-expanded={all}>
          {all ? 'Show fewer' : `Show all (${items.length})`}
        </SidebarMore>
      )}
      {chats.isError && (
        <SidebarMore type="button" onClick={() => void chats.refetch()}>
          Retry loading chats
        </SidebarMore>
      )}
      {chats.isSuccess && !items.length && (
        <Box px="2" py="1.5">
          <styled.p fontSize="1" color="text.muted">
            Your chats will appear here.
          </styled.p>
        </Box>
      )}
      {actions.dialogs}
    </SidebarSection>
  );
};
