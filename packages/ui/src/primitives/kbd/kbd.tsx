import type * as React from 'react';

import { cva, type RecipeVariantProps } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const kbdStyles = cva({
  base: {
    '[data-slot=tooltip-content] &': {
      _dark: {
        bg: 'background.app/10',
      },
      bg: 'background.app/20',
      color: 'background.app',
    },
    '& svg:not([class*="size-"])': {
      h: '0.75rem',
      w: '0.75rem',
    },
    alignItems: 'center',
    bg: 'background.muted',
    color: 'text.muted',
    display: 'inline-flex',
    fontFamily: 'sans',
    fontSize: '1',
    fontWeight: '500',
    gap: '1',
    h: '1.25rem',
    justifyContent: 'center',
    minW: '1.25rem',
    pointerEvents: 'none',
    px: '1',
    rounded: 'sm',
    userSelect: 'none',
    w: 'fit-content',
  },
});

const StyledKbd = styled('kbd', kbdStyles);

export type KbdVariants = RecipeVariantProps<typeof kbdStyles>;

export type KbdProps = React.ComponentProps<'kbd'> &
  KbdVariants &
  JsxStyleProps;

export const Kbd = (props: KbdProps) => {
  return <StyledKbd data-slot="kbd" {...props} />;
};
