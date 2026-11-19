import * as React from 'react';

import { Avatar as AvatarPrimitive } from 'radix-ui';

import { cva } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

type Element = React.ElementRef<typeof AvatarPrimitive.AvatarFallback>;

const avatarFallbackStyle = cva({
  base: {
    alignItems: 'center',
    aspectRatio: 'square',
    bg: 'muted',
    display: 'flex',
    h: '100%',
    justifyContent: 'center',
    w: '100%',
  },
});

const StyledAvatarFallback = styled(
  AvatarPrimitive.AvatarFallback,
  avatarFallbackStyle,
);

export type AvatarFallbackProps = React.ComponentPropsWithoutRef<
  typeof AvatarPrimitive.AvatarFallback
> &
  JsxStyleProps;

export const AvatarFallback = React.forwardRef<Element, AvatarFallbackProps>(
  function AvatarFallback({ ...props }, ref) {
    return <StyledAvatarFallback ref={ref} {...props} />;
  },
);
