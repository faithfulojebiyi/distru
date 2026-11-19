import { Combobox as ComboboxPrimitive } from '@base-ui/react';

import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const StyledSeparator = styled(ComboboxPrimitive.Separator);

export type ComboboxSeparatorProps = ComboboxPrimitive.Separator.Props &
  JsxStyleProps;

export const ComboboxSeparator = ({ ...props }: ComboboxSeparatorProps) => {
  return (
    <StyledSeparator
      bg="border.subtle"
      data-slot="combobox-separator"
      h="px"
      mx="-1"
      my="1"
      {...props}
    />
  );
};
