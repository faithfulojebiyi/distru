import * as React from 'react';

import { Avatar as AvatarPrimitive } from 'radix-ui';

import type { RecipeVariantProps } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

import { avatarRootStyle } from './avatar-styles';

type Element = React.ElementRef<typeof AvatarPrimitive.Root>;

const StyledAvatar = styled(AvatarPrimitive.Root, avatarRootStyle);

export type AvatarVariants = RecipeVariantProps<typeof avatarRootStyle>;

export type AvatarProps = React.ComponentPropsWithoutRef<
  typeof AvatarPrimitive.Root
> &
  AvatarVariants &
  JsxStyleProps;

export const Avatar = React.forwardRef<Element, AvatarProps>(function Avatar(
  { ...props },
  ref,
) {
  return <StyledAvatar ref={ref} {...props} />;
});
