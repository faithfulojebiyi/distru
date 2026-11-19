import type * as React from 'react';

import { cva } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const cardContentStyles = cva({
  base: {
    '[data-size=sm] &': { px: '3' },
    px: '4',
  },
});

const StyledCardContent = styled('div', cardContentStyles);

export const CardContent = ({
  ...props
}: React.ComponentProps<'div'> & JsxStyleProps) => {
  return <StyledCardContent data-slot="card-content" {...props} />;
};
