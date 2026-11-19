import type { JSX, SVGProps } from 'react';

import type { StyledComponent } from '@ops/ui/types';

export type IconProps = SVGProps<SVGSVGElement> & {
  size?: string | number;
};

export type TIcon = StyledComponent<(props: IconProps) => JSX.Element>;
