import type * as React from 'react';

import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';

import { cva } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const radioGroupStyles = cva({
  base: {
    display: 'grid',
    gap: '2',
    w: 'full',
  },
});

const StyledRadioGroup = styled(RadioGroupPrimitive.Root, radioGroupStyles);

type RadioGroupProps = React.ComponentProps<typeof RadioGroupPrimitive.Root> &
  JsxStyleProps;

export const RadioGroup = (props: RadioGroupProps) => (
  <StyledRadioGroup data-slot="radio-group" {...props} />
);
