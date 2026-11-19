import type * as React from 'react';

import { Drawer as DrawerPrimitive } from 'vaul';

import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const StyledDescription = styled(DrawerPrimitive.Description);

type Props = React.ComponentProps<typeof DrawerPrimitive.Description> &
  JsxStyleProps;

export const DrawerDescription: React.FC<Props> = (props) => {
  return (
    <StyledDescription
      color="text.muted"
      data-slot="drawer-description"
      fontSize="sm"
      {...props}
    />
  );
};
