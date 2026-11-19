import type * as React from 'react';

import { cva, cx } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const tableCellStyles = cva({
  base: {
    '&:has([role=checkbox])': {
      pr: '0',
    },
    p: '7px',
    verticalAlign: 'middle',
    whiteSpace: 'nowrap',
  },
});

const StyledTableCell = styled('td', tableCellStyles);

export const TableCell = ({
  className,
  ...props
}: React.ComponentProps<'td'> & JsxStyleProps) => {
  return (
    <StyledTableCell
      className={cx(className)}
      data-slot="table-cell"
      {...props}
    />
  );
};
