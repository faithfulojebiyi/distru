import type * as React from 'react';

import { Dialog as DialogPrimitive } from 'radix-ui';

import { cva } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

type Props = React.ComponentProps<typeof DialogPrimitive.Title> & JsxStyleProps;

const descriptionStyles = cva({
  base: {
    fontSize: '2',
  },
});

const StyledDialogDescription = styled(
  DialogPrimitive.Description,
  descriptionStyles,
);

export const DialogDescription = function DialogDescription({
  ...props
}: Props) {
  return <StyledDialogDescription data-slot="dialog-description" {...props} />;
};
