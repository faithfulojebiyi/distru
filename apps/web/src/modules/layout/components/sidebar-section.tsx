// Adapted from carbonme modules/layout/components/workflow-sidebar-tree.tsx (a labelled sidebar section whose header
// folds it, with a "+" beside the label) and app-sidebar.tsx (sections hide in the collapsed, icon-only sidebar).
import { useState, type ReactNode } from 'react';
import { css } from '@ops/ui/css';
import { Box, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { SidebarGroup } from '@ops/ui/primitives/sidebar';

const storageKey = (id: string) => `ops.sidebar.${id}.open`;

const readOpen = (id: string) => {
  try {
    return window.localStorage.getItem(storageKey(id)) !== 'false';
  } catch {
    return true;
  }
};

const writeOpen = (id: string, open: boolean) => {
  try {
    window.localStorage.setItem(storageKey(id), String(open));
  } catch {
    // A blocked storage only forgets the fold.
  }
};

/** In the collapsed (icon-only) sidebar the sections hide; the nav icons stay. */
const hiddenWhenIconClass = css({ py: '1', '[data-collapsible=icon] &': { display: 'none' } });

/** A foldable sidebar section ("Chats", "Runs"): label + caret, an optional action, the rows. Hidden in icon mode. */
export const SidebarSection = ({
  id,
  label,
  action,
  children,
}: {
  id: string;
  label: string;
  action?: ReactNode;
  children: ReactNode;
}) => {
  const [open, setOpen] = useState(() => (typeof window === 'undefined' ? true : readOpen(id)));
  const toggle = () => {
    setOpen(!open);
    writeOpen(id, !open);
  };
  return (
    <SidebarGroup className={hiddenWhenIconClass} data-sidebar-section={id}>
      <HStack gap="1" h="8" px="2" pr="1">
        <styled.button
          type="button"
          display="flex"
          alignItems="center"
          gap="1"
          flex="1"
          minW="0"
          h="full"
          color="text.muted"
          fontSize="0.75rem"
          fontWeight="500"
          letterSpacing="0.025em"
          cursor="pointer"
          rounded="md"
          _hover={{ color: 'text.app' }}
          _focusVisible={{ outline: '2px solid', outlineColor: 'border.focused', outlineOffset: '-2px' }}
          aria-expanded={open}
          onClick={toggle}
        >
          {label}
          <styled.span display="flex" transform={open ? undefined : 'rotate(-90deg)'} transition="transform 0.15s">
            <Icons.caretDown size={10} />
          </styled.span>
        </styled.button>
        {action}
      </HStack>
      {open && (
        <Box px="1" role="region" aria-label={label}>
          {children}
        </Box>
      )}
    </SidebarGroup>
  );
};

/** The small text button under a section's rows ("Show all", "View all"); a class so a Link can wear it too. */
export const sidebarMoreClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '1.5',
  h: '7',
  px: '2',
  mt: '0.5',
  rounded: 'md',
  fontSize: '1',
  color: 'text.muted',
  cursor: 'pointer',
  _hover: { bg: 'brand.panel.6', color: 'text.app' },
  _focusVisible: { outline: '2px solid', outlineColor: 'border.focused', outlineOffset: '-2px' },
});

export const SidebarMore = (props: React.ComponentProps<'button'>) => <button className={sidebarMoreClass} {...props} />;
