import type * as React from 'react';

import { cva } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const breadcrumbPageStyles = cva({
  base: {
    color: 'text.app',
    fontWeight: '400',
  },
});

const StyledSpan = styled('span', breadcrumbPageStyles);

export type BreadcrumbPageProps = React.ComponentProps<'span'> & JsxStyleProps;

export const BreadcrumbPage = ({ ...props }: BreadcrumbPageProps) => {
  return (
    <StyledSpan
      aria-current="page"
      aria-disabled="true"
      data-slot="breadcrumb-page"
      role="link"
      {...props}
    />
  );
};
