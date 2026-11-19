import type * as React from 'react';

import { cva } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const tableBodyStyles = cva({
  base: {
    '& tr:last-child': {
      borderBottom: 'none',
    },
  },
});

const StyledTableBody = styled('tbody', tableBodyStyles);

export const TableBody = ({
  ...props
}: React.ComponentProps<'tbody'> & JsxStyleProps) => {
  return <StyledTableBody data-slot="table-body" {...props} />;
};
