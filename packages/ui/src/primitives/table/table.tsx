import type * as React from 'react';

import { cva } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

// Table Container (wrapper div)
const tableContainerStyles = cva({
  base: {
    overflowX: 'auto',
    position: 'relative',
    w: 'full',
  },
});

// Table
const tableStyles = cva({
  base: {
    captionSide: 'bottom',
    fontSize: '1',
    w: 'full',
  },
});

const StyledTable = styled('table', tableStyles);

export const TableContainer = ({
  children,
  ...props
}: React.ComponentProps<'table'> & JsxStyleProps) => {
  return (
    <div className={tableContainerStyles()} data-slot="table-container">
      <StyledTable data-slot="table" {...props}>
        {children}
      </StyledTable>
    </div>
  );
};
