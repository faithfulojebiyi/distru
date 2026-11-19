import type * as React from 'react';

import { cva } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const tableCaptionStyles = cva({
  base: {
    color: 'text.muted',
    fontSize: '1',
    mt: '4',
  },
});

const StyledTableCaption = styled('caption', tableCaptionStyles);

export const TableCaption = ({
  ...props
}: React.ComponentProps<'caption'> & JsxStyleProps) => {
  return <StyledTableCaption data-slot="table-caption" {...props} />;
};
