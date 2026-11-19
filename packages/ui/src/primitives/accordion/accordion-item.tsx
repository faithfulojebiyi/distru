import type * as React from 'react';

import { Accordion as AccordionPrimitive } from 'radix-ui';

import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const StyledAccordionItem = styled(AccordionPrimitive.Item);

export const AccordionItem = ({
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Item> & JsxStyleProps) => {
  return <StyledAccordionItem {...props} />;
};
