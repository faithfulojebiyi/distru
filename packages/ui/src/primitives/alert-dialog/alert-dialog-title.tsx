import { AlertDialog as AlertDialogPrimitive } from 'radix-ui';

import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const StyledTitle = styled(AlertDialogPrimitive.Title);

export const AlertDialogTitle = ({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title> & JsxStyleProps) => {
  return (
    <StyledTitle
      data-slot="alert-dialog-title"
      fontSize="3"
      fontWeight="500"
      {...props}
    />
  );
};
