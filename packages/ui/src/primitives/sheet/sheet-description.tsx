import type * as React from 'react';

import { Dialog as SheetPrimitive } from 'radix-ui';

import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const StyledDescription = styled(SheetPrimitive.Description);

type Props = React.ComponentProps<typeof SheetPrimitive.Description> &
  JsxStyleProps;

export const SheetDescription: React.FC<Props> = (props) => {
  return (
    <StyledDescription
      color="text.muted"
      fontSize="1"
      fontWeight="500"
      {...props}
    />
  );
};
