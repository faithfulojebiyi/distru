import type * as React from 'react';

import { cva, type RecipeVariantProps } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const kbdGroupStyles = cva({
  base: {
    alignItems: 'center',
    display: 'inline-flex',
    gap: '1',
  },
});

const StyledKbdGroup = styled('div', kbdGroupStyles);

export type KbdGroupVariants = RecipeVariantProps<typeof kbdGroupStyles>;

export type KbdGroupProps = React.ComponentProps<'div'> &
  KbdGroupVariants &
  JsxStyleProps;

export const KbdGroup = (props: KbdGroupProps) => {
  return <StyledKbdGroup data-slot="kbd-group" {...props} />;
};
