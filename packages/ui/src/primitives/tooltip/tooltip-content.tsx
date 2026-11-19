import type * as React from 'react';

import { Tooltip as TooltipPrimitive } from 'radix-ui';

import { cva } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

export type TooltipContentProps = React.ComponentProps<
  typeof TooltipPrimitive.Content
> &
  JsxStyleProps;

const tooltipContentStyles = cva({
  base: {
    _light: {
      bg: 'white',
    },
    bgColor: 'background.popover',
    border: 'subtle',
    color: 'text.app.1',
    fontSize: '1',
    fontWeight: '500',
    glass: 'popup',
    px: '1.5',
    py: '1',
    rounded: '2xl',
    shadow: 'sMd',
    whiteSpace: 'normal',
    zIndex: 101,
  },
});

const StyledContent = styled(TooltipPrimitive.Content, tooltipContentStyles);

export const TooltipContent = ({
  sideOffset = 4,
  ...props
}: TooltipContentProps) => {
  return (
    <TooltipPrimitive.Portal data-slot="tooltip-portal">
      <StyledContent
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
};

export const TooltipPortal = TooltipPrimitive.Portal;
