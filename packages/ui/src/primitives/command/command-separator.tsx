import type * as React from 'react';

import { Command as CommandPrimitive } from 'cmdk';

import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const StyledCommandSeparator = styled(CommandPrimitive.Separator);

export const CommandSeparator = ({
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator> & JsxStyleProps) => {
  return (
    <StyledCommandSeparator
      bg="background.muted"
      data-slot="command-separator"
      h="1px"
      my="1"
      w="full"
      {...props}
    />
  );
};
