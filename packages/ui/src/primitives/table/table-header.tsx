import type * as React from 'react';

import { cva } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const tableHeaderStyles = cva({
  base: {
    '& tr': {
      borderBottom: 'subtle',
    },
  },
});

const StyledTableHeader = styled('thead', tableHeaderStyles);

export const TableHeader = ({
  ...props
}: React.ComponentProps<'thead'> & JsxStyleProps) => {
  return <StyledTableHeader data-slot="table-header" {...props} />;
};
