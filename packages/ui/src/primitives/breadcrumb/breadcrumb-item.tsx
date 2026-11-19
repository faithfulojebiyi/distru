import type * as React from 'react';

import { cva } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const breadcrumbItemStyles = cva({
  base: {
    alignItems: 'center',
    display: 'inline-flex',
    gap: '1.5',
  },
});

const StyledLi = styled('li', breadcrumbItemStyles);

export type BreadcrumbItemProps = React.ComponentProps<'li'> & JsxStyleProps;

export const BreadcrumbItem = ({ ...props }: BreadcrumbItemProps) => {
  return <StyledLi data-slot="breadcrumb-item" {...props} />;
};
