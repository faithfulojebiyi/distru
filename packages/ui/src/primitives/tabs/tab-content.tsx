import type * as React from 'react';

import { Tabs as TabsPrimitive } from 'radix-ui';

import { cva } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';
import type { JsxStyleProps } from '@ops/ui/types';

const tabContentStyles = cva({
  base: {
    _focusVisible: {
      outline: 'none',
    },
  },
});

const StyledTabContent = styled(TabsPrimitive.Content, tabContentStyles);

export const TabContent = (
  props: React.ComponentProps<typeof TabsPrimitive.Content> & JsxStyleProps,
) => {
  return <StyledTabContent {...props} />;
};
