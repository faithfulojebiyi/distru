import type * as React from 'react';

import { AlertDialog as AlertDialogPrimitive } from 'radix-ui';

import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const StyledCancel = styled(AlertDialogPrimitive.Cancel);

export const AlertDialogCancel = (
  props: React.ComponentProps<typeof AlertDialogPrimitive.Cancel> &
    JsxStyleProps,
) => {
  return <StyledCancel {...props} />;
};
