import type * as React from 'react';

import { css } from '@ops/ui/css';
import type { JsxStyleProps } from '@ops/ui/types';

type SidebarMenuItemProps = React.ComponentProps<'li'> & JsxStyleProps;

const menuItemStyles = css({
  '&:hover > [data-show-on-hover]': {
    opacity: '1',
    pointerEvents: 'auto',
  },
  display: 'flex',
  flexDirection: 'column',
  gap: '1',
  position: 'relative',
});

export const SidebarMenuItem = (props: SidebarMenuItemProps) => {
  return (
    <li className={menuItemStyles} data-slot="sidebar-menu-item" {...props} />
  );
};
