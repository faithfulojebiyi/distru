import type * as React from 'react';

import { Input as InputPrimitive } from '@base-ui/react/input';

import type { RecipeVariantProps } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

import { inputStyles } from './input-styles';

const StyledInput = styled(InputPrimitive, inputStyles);

export type InputVariants = RecipeVariantProps<typeof inputStyles>;

export type InputProps = Omit<React.ComponentProps<'input'>, 'size'> &
  JsxStyleProps &
  InputVariants;

export const Input = ({ size = 'xs', ...props }: InputProps) => {
  return <StyledInput data-slot="input" size={size} {...props} />;
};
