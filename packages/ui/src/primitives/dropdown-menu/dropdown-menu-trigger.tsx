import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';

import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const StyledTrigger = styled(DropdownMenuPrimitive.Trigger);

export const DropdownMenuTrigger = ({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger> &
  JsxStyleProps) => {
  return <StyledTrigger data-slot="dropdown-menu-trigger" {...props} />;
};
