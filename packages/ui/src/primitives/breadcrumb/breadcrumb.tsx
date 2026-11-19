import type * as React from 'react';

import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

export type BreadcrumbProps = React.ComponentProps<'nav'> & JsxStyleProps;

const StyledNav = styled('nav');

export const Breadcrumb = ({ ...props }: BreadcrumbProps) => {
  return (
    <StyledNav aria-label="breadcrumb" data-slot="breadcrumb" {...props} />
  );
};
