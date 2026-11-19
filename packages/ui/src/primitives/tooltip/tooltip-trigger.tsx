import { Tooltip as TooltipPrimitive } from 'radix-ui';

import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const StyledTrigger = styled(TooltipPrimitive.Trigger);

export const TooltipTrigger = ({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger> & JsxStyleProps) => {
  return <StyledTrigger data-slot="tooltip-trigger" {...props} />;
};
