// Copied from carbonme modules/chats/chat-actions.tsx (RenameDialog, DeleteDialog, useChatActions, ChatActionsMenu),
// with "Copy link" added and Delete confirmed for good (Copilot chats have no Trash).
import { useState, type ReactNode } from 'react';
import { Flex, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { Button } from '@ops/ui/primitives/button';
import { Dialog, DialogContent, DialogTitle } from '@ops/ui/primitives/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@ops/ui/primitives/dropdown-menu';
import { Input } from '@ops/ui/primitives/input';
import { toast } from '@ops/ui/primitives/toast/toast';
import { useDeleteChat, useRenameChat } from './copilot-api';
import { CHAT_TITLE_MAX, chatTitle } from './copilot-chats-data';

/** The part of a chat its rename and delete need. */
export type ChatRef = { id: string; title?: string | null };

type ChatAction = { kind: 'rename' | 'delete'; item: ChatRef };

/** Mounted per rename so the field starts from the current title. */
const RenameDialog = ({ item, close }: { item: ChatRef; close: () => void }) => {
  const [title, setTitle] = useState(item.title ?? '');
  const update = useRenameChat();
  return (
    <Dialog open onOpenChange={(open) => !open && !update.isPending && close()}>
      <DialogContent p="5">
        <DialogTitle mb="4">Rename chat</DialogTitle>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim()) update.mutate({ threadId: item.id, title }, { onSuccess: close });
          }}
        >
          <Flex direction="column" gap="4">
            <Input
              aria-label="Chat title"
              autoFocus
              required
              maxLength={CHAT_TITLE_MAX * 2}
              placeholder="Chat title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={update.isPending}
            />
            <Button type="submit" disabled={update.isPending || !title.trim()}>
              {update.isPending ? 'Saving…' : 'Save'}
            </Button>
          </Flex>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const DeleteDialog = ({ item, close, deleted }: { item: ChatRef; close: () => void; deleted: () => void }) => {
  const remove = useDeleteChat();
  return (
    <Dialog open onOpenChange={(open) => !open && !remove.isPending && close()}>
      <DialogContent p="5">
        <DialogTitle mb="4">Delete chat</DialogTitle>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            remove.mutate(item.id, { onSuccess: deleted });
          }}
        >
          <Flex direction="column" gap="4">
            <styled.p color="text.muted" fontSize="2">
              Delete “{chatTitle(item.title)}” and its conversation? This can’t be undone. Runs and proposals it
              started stay.
            </styled.p>
            {remove.isError && (
              <styled.p role="alert" color="text.error" fontSize="1">
                Could not delete the chat. Try again.
              </styled.p>
            )}
            <Button type="submit" disabled={remove.isPending} data-confirm-delete="">
              {remove.isPending ? 'Deleting…' : 'Delete chat'}
            </Button>
          </Flex>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/** Rename and delete for any chat, confirmed in in-page dialogs; `dialogs` must be rendered once. */
export const useChatActions = (options: { deleted?: (item: ChatRef) => void } = {}) => {
  const [action, setAction] = useState<ChatAction | null>(null);
  const close = () => setAction(null);
  return {
    rename: (item: ChatRef) => setAction({ kind: 'rename', item }),
    remove: (item: ChatRef) => setAction({ kind: 'delete', item }),
    dialogs: (
      <>
        {action?.kind === 'rename' && <RenameDialog key={action.item.id} item={action.item} close={close} />}
        {action?.kind === 'delete' && (
          <DeleteDialog
            item={action.item}
            close={close}
            deleted={() => {
              close();
              options.deleted?.(action.item);
            }}
          />
        )}
      </>
    ),
  };
};

export type ChatActions = ReturnType<typeof useChatActions>;

const copyLink = (id: string) =>
  void navigator.clipboard
    .writeText(`${window.location.origin}/copilot/${id}`)
    .then(() => toast.success('Link copied.'))
    .catch(() => toast.error('Could not copy the link.'));

/** The `···` button with Rename, Copy link and Delete, beside a sidebar row or the chat title. */
export const ChatActionsMenu = ({
  item,
  actions,
  side = 'bottom',
  header,
}: {
  item: ChatRef;
  actions: ChatActions;
  side?: 'bottom' | 'right';
  header?: ReactNode;
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button aria-label={`Actions for ${chatTitle(item.title)}`} size="icon" variant="ghost" flexShrink="0">
        <Icons.ellipsis />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent shadow="sLg" side={side} align="start">
      {header}
      <DropdownMenuItem onSelect={() => actions.rename(item)}>
        <Icons.squarePen />
        Rename
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => copyLink(item.id)}>
        <Icons.link />
        Copy link
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem color="brand.error.11" onSelect={() => actions.remove(item)}>
        <Icons.trash />
        Delete chat
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);
