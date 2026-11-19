import type * as React from 'react';

import { cva } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const tableFooterStyles = cva({
  base: {
    '& > tr:last-child': {
      borderBottom: 'none',
    },
    bg: 'background.muted',
    borderTop: 'subtle',
    fontWeight: 'medium',
  },
});

const StyledTableFooter = styled('tfoot', tableFooterStyles);

export const TableFooter = ({
  ...props
}: React.ComponentProps<'tfoot'> & JsxStyleProps) => {
  return <StyledTableFooter data-slot="table-footer" {...props} />;
};
