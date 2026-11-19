import type * as React from 'react';

import { Separator as SeparatorPrimitive } from 'radix-ui';

import { cva } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

export type SeparatorProps = React.ComponentPropsWithoutRef<
  typeof SeparatorPrimitive.Root
> &
  JsxStyleProps & {
    orientation?: 'horizontal' | 'vertical';
    decorative?: boolean;
  };

const separatorStyles = cva({
  base: {
    bg: 'palette.gray.3',
    flexShrink: 0,
  },
});

const StyledSeparator = styled(SeparatorPrimitive.Root, separatorStyles);

export const Separator = ({
  orientation = 'horizontal',
  decorative = true,
  ...props
}: SeparatorProps) => {
  return (
    <StyledSeparator
      decorative={decorative}
      orientation={orientation}
      {...props}
      style={{
        height: orientation === 'horizontal' ? '1px' : '100%',
        width: orientation === 'vertical' ? '1px' : '100%',
      }}
    />
  );
};
