import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';

import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const StyledRadioGroup = styled(DropdownMenuPrimitive.RadioGroup);

export const DropdownMenuRadioGroup = ({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup> &
  JsxStyleProps) => {
  return <StyledRadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
};
