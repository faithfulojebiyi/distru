import * as React from 'react';

import * as SliderPrimitive from '@radix-ui/react-slider';

import { cva } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import {
  JsxStyleProps,
  RecipeVariantProps,
} from '@ops/ui/types';

const rangeStyles = cva({
  base: {
    borderRadius: 'full',
    height: '100%',
    position: 'absolute',
  },
  defaultVariants: {
    size: 'xs',
  },
  variants: {
    look: {
      error: {
        bg: 'error.9',
      },
      purple: {
        bg: 'brand.primary.9',
      },
      success: {
        bg: 'success.9',
      },
      usage: {},
    },
    size: {
      lg: {
        h: '2rem',
      },
      md: {
        h: '1.6rem',
      },
      sm: {
        h: '1.2rem',
      },
      xs: {
        h: '0.8rem',
      },
      xxs: {
        h: '0.4rem',
      },
    },
  },
});

const StyledRange = styled(SliderPrimitive.Range, rangeStyles);

type RangeVariants = RecipeVariantProps<typeof rangeStyles>;
export type SliderRangeProps = React.ComponentProps<
  typeof SliderPrimitive.Range
> &
  JsxStyleProps &
  RangeVariants;

export const SliderRange = (props: SliderRangeProps) => {
  return <StyledRange {...props} />;
};
