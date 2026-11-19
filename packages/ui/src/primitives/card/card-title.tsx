import type * as React from 'react';

import { cva } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const cardTitleStyles = cva({
  base: {
    '[data-size=sm] &': { fontSize: '2' },
    fontSize: '3',
    fontWeight: 'medium',
    lineHeight: 'snug',
  },
});

const StyledCardTitle = styled('div', cardTitleStyles);

export const CardTitle = ({
  ...props
}: React.ComponentProps<'div'> & JsxStyleProps) => {
  return <StyledCardTitle data-slot="card-title" {...props} />;
};
