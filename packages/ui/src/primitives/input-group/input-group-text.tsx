import type * as React from 'react';

import { cva } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const inputGroupTextStyles = cva({
  base: {
    '& svg': {
      pointerEvents: 'none',
    },

    '& svg:not([class*="size-"])': {
      h: '4',
      w: '4',
    },

    alignItems: 'center',
    color: 'text.muted',
    display: 'flex',
    fontSize: '1',
    gap: '2',
  },
});

const StyledInputGroupText = styled('span', inputGroupTextStyles);

export type InputGroupTextProps = React.ComponentProps<'span'> & JsxStyleProps;

export const InputGroupText = ({ ...props }: InputGroupTextProps) => {
  return <StyledInputGroupText {...props} />;
};
