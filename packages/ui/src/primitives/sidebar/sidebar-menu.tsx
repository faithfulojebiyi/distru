import type * as React from 'react';

import { css } from '@ops/ui/css';
import type { JsxStyleProps } from '@ops/ui/types';

type SidebarMenuProps = React.ComponentProps<'ul'> & JsxStyleProps;

const menuStyles = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '1',
  minW: '0',
  w: 'full',
});

export const SidebarMenu = (props: SidebarMenuProps) => {
  return <ul className={menuStyles} data-slot="sidebar-menu" {...props} />;
};
