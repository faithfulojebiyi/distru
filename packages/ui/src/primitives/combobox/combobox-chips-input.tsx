import { Combobox as ComboboxPrimitive } from '@base-ui/react';

import { cva } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const chipsInputStyles = cva({
  base: {
    flex: '1',
    minW: '4rem',
    outline: 'none',
  },
});

const StyledChipsInput = styled(ComboboxPrimitive.Input, chipsInputStyles);

export type ComboboxChipsInputProps = ComboboxPrimitive.Input.Props &
  JsxStyleProps;

export const ComboboxChipsInput = ({ ...props }: ComboboxChipsInputProps) => {
  return <StyledChipsInput data-slot="combobox-chip-input" {...props} />;
};
