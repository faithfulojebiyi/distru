import type * as React from 'react';

import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';

import { cva } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const separatorStyles = cva({
  base: { bg: 'background.muted', h: '1px', mx: '-1', my: '4px' },
});

const StyledSeparator = styled(
  DropdownMenuPrimitive.Separator,
  separatorStyles,
);

export const DropdownMenuSeparator = (
  props: React.ComponentProps<typeof DropdownMenuPrimitive.Separator> &
    JsxStyleProps,
) => {
  return <StyledSeparator data-slot="dropdown-menu-separator" {...props} />;
};
