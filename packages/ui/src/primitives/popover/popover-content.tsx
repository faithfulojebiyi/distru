import type * as React from 'react';

import { Popover as PopoverPrimitive } from 'radix-ui';

import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

import { AnimateChangeInHeight } from '../animated-height';
import { popoverContentStyles } from './popover-content-styles';

const StyledPopoverContent = styled(
  PopoverPrimitive.Content,
  popoverContentStyles,
);

export type PopoverContentProps = React.ComponentProps<
  typeof PopoverPrimitive.Content
> &
  JsxStyleProps;

export const PopoverContent: React.FC<PopoverContentProps> = ({
  align = 'center',
  sideOffset = 4,
  children,
  style,
  ...props
}) => {
  return (
    <PopoverPrimitive.Portal>
      <StyledPopoverContent
        align={align}
        data-slot="popover-content"
        sideOffset={sideOffset}
        style={{
          ...style,
        }}
        {...props}
      >
        <AnimateChangeInHeight duration={0.05}>
          {children}
        </AnimateChangeInHeight>
      </StyledPopoverContent>
    </PopoverPrimitive.Portal>
  );
};
