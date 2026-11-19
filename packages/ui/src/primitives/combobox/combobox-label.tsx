import { Combobox as ComboboxPrimitive } from '@base-ui/react';

import { cva } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const labelStyles = cva({
  base: {
    color: 'text.muted',
    fontSize: '1',
    px: '2',
    py: '1.5',
  },
});

const StyledLabel = styled(ComboboxPrimitive.GroupLabel, labelStyles);

export type ComboboxLabelProps = ComboboxPrimitive.GroupLabel.Props &
  JsxStyleProps;

export const ComboboxLabel = ({ ...props }: ComboboxLabelProps) => {
  return <StyledLabel data-slot="combobox-label" {...props} />;
};
