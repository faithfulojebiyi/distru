import { ContextMenu as ContextMenuPrimitive } from 'radix-ui';

import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const StyledGroup = styled(ContextMenuPrimitive.Group);

export const ContextMenuGroup = ({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Group> & JsxStyleProps) => {
  return <StyledGroup data-slot="context-menu-group" {...props} />;
};
