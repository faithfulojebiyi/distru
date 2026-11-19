import type * as React from 'react';

import { Command as CommandPrimitive } from 'cmdk';

import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const StyledCommand = styled(CommandPrimitive, {});

type Props = React.ComponentProps<typeof CommandPrimitive> & JsxStyleProps;

export const Command = ({ filter: _filter, ...props }: Props) => {
  return <StyledCommand data-slot="command" {...props} />;
};
