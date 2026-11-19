import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';

import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const StyledGroup = styled(DropdownMenuPrimitive.Group);

export const DropdownMenuGroup = ({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Group> &
  JsxStyleProps) => {
  return <StyledGroup data-slot="dropdown-menu-group" {...props} />;
};
