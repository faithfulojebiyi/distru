import type * as React from 'react';

import { Dialog as SheetPrimitive } from 'radix-ui';

import { cva } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';

const overlayStyles = cva({
  base: {
    bg: 'background.popoverOverlay',
    glass: 'overlay',
    inset: '0',
    pos: 'fixed',
    zIndex: '100',
  },
});

const StyledOverlay = styled(SheetPrimitive.Overlay, overlayStyles);

export const SheetOverlay = (
  props: React.ComponentProps<typeof SheetPrimitive.Overlay>,
) => {
  return <StyledOverlay {...props} />;
};
