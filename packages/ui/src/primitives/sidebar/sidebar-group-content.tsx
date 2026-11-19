import type * as React from 'react';

import { css } from '@ops/ui/css';
import type { JsxStyleProps } from '@ops/ui/types';

type SidebarGroupContentProps = React.ComponentProps<'div'> & JsxStyleProps;

const groupContentStyles = css({
  fontSize: 'sm',
  w: 'full',
});

export const SidebarGroupContent = (props: SidebarGroupContentProps) => {
  return (
    <div
      className={groupContentStyles}
      data-slot="sidebar-group-content"
      {...props}
    />
  );
};
