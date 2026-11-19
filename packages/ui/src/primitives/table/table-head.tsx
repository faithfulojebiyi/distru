import type * as React from 'react';

import { cva } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const tableHeadStyles = cva({
  base: {
    '&:has([role=checkbox])': {
      pr: '0',
    },
    color: 'text.app',
    fontWeight: 'medium',
    h: '10',
    px: '2',
    textAlign: 'left',
    verticalAlign: 'middle',
    whiteSpace: 'nowrap',
  },
});

const StyledTableHead = styled('th', tableHeadStyles);

export const TableHead = ({
  ...props
}: React.ComponentProps<'th'> & JsxStyleProps) => {
  return <StyledTableHead data-slot="table-head" {...props} />;
};
