import type * as React from 'react';

import { Command as CommandPrimitive } from 'cmdk';

import { cva } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

type Props = React.ComponentProps<typeof CommandPrimitive.List> & JsxStyleProps;

const commandListStyles = cva({
  base: {
    '&::-webkit-scrollbar': {
      display: 'none',
    },
    // The height cmdk measures is its items' height; padding must sit outside it or the last item is cut off.
    boxSizing: 'content-box',
    h: 'var(--cmdk-list-height)',
    maxH: '25rem',
    overflowX: 'hidden',
    overflowY: 'scroll',
    p: '1',
    scrollPaddingBlockEnd: '8px',
    scrollPaddingBlockStart: '8px',
  },
});

const StyledList = styled(CommandPrimitive.List, commandListStyles);

export const CommandList = ({ children, ...props }: Props) => {
  return (
    <StyledList data-slot="command-list" {...props}>
      {children}
    </StyledList>
  );
};
