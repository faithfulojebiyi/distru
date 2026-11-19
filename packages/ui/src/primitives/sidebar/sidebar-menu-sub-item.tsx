import type * as React from 'react';

import { css } from '@ops/ui/css';
import type { JsxStyleProps } from '@ops/ui/types';

type SidebarMenuSubItemProps = React.ComponentProps<'li'> & JsxStyleProps;

const subItemStyles = css({
  position: 'relative',
});

export const SidebarMenuSubItem = (props: SidebarMenuSubItemProps) => {
  return (
    <li
      className={subItemStyles}
      data-slot="sidebar-menu-sub-item"
      {...props}
    />
  );
};
