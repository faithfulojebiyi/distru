import type * as React from 'react';

import { AlertDialog as AlertDialogPrimitive } from 'radix-ui';

import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const StyledDescription = styled(AlertDialogPrimitive.Description);

export const AlertDialogDescription = (
  props: React.ComponentProps<typeof AlertDialogPrimitive.Description> &
    JsxStyleProps,
) => {
  return (
    <StyledDescription
      color="text.muted"
      data-slot="alert-dialog-description"
      fontWeight="500"
      {...props}
    />
  );
};
