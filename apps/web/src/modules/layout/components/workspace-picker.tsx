// Adapted from carbonme modules/layout/components/workspace-picker.tsx: the avatar chip, the workspace name and a
// chevron that turns. Ops Agent serves one Distru account, so the menu only names it (no switching).
import { useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { Box } from '@ops/ui/jsx';
import { Avatar, AvatarFallback } from '@ops/ui/primitives/avatar';
import { Button } from '@ops/ui/primitives/button';
import { Icons } from '@ops/ui/icons/base';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@ops/ui/primitives/dropdown-menu';

/** The distributor whose Distru account this harness runs on. */
export const WORKSPACE_NAME = 'Golden Coast Distribution';

export const WorkspacePicker = () => {
  const [open, setOpen] = useState(false);
  const reducedMotion = useReducedMotion();
  const name = WORKSPACE_NAME;
  const initials = name
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Workspace"
          size="sm"
          variant="ghost"
          justifyContent="flex-start"
          gap="2"
          minW="0"
          flex="1"
          px="0"
          css={{
            '& > [data-slot=button-content]': { minW: '0', flex: '1' },
            '[data-collapsible=icon] &': { flex: 'none' },
          }}
          data-workspace-picker=""
        >
          <Avatar radius="md" size={1}>
            <AvatarFallback bg="brand.primary.9" color="brand.primary.1" fontSize="1" fontWeight="600">
              {initials}
            </AvatarFallback>
          </Avatar>
          <Box
            css={{ '[data-collapsible=icon] &': { display: 'none' } }}
            fontSize="2"
            fontWeight="600"
            minW="0"
            title={name}
            truncate
          >
            {name}
          </Box>
          <Icons.caretDown
            size={12}
            color="text.muted"
            aria-hidden="true"
            flexShrink="0"
            style={{
              transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: reducedMotion ? 'none' : 'transform 180ms ease',
            }}
            css={{ '[data-collapsible=icon] &': { display: 'none' } }}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" shadow="sLg" minW="13rem">
        <DropdownMenuLabel>Workspace</DropdownMenuLabel>
        <DropdownMenuItem>
          {name}
          <Icons.check ml="auto" />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled>Distru ERP · one account per harness</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
