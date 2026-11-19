import type * as React from 'react';

import { cva } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const cardDescriptionStyles = cva({
  base: {
    color: 'text.muted',
    fontSize: '2',
  },
});

const StyledCardDescription = styled('div', cardDescriptionStyles);

export const CardDescription = ({
  ...props
}: React.ComponentProps<'div'> & JsxStyleProps) => {
  return <StyledCardDescription data-slot="card-description" {...props} />;
};
