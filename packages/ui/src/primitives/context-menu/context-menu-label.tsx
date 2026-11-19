import type React from 'react';

import { ContextMenu as ContextMenuPrimitive } from 'radix-ui';

import { cva } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

type Props = React.ComponentProps<typeof ContextMenuPrimitive.Label> & {
  inset?: boolean;
} & JsxStyleProps;

const styles = cva({
  base: { my: '4px' },
});

const StyledLabel = styled(ContextMenuPrimitive.Label, styles);

export const ContextMenuLabel = ({ ...props }: Props) => {
  return <StyledLabel data-slot="context-menu-label" {...props} />;
};
