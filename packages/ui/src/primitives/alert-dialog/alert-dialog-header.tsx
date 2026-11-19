import type { FlexProps } from '@ops/ui/jsx';

import { Flex } from '../layout';

export const AlertDialogHeader = (props: FlexProps) => {
  return <Flex data-slot="alert-dialog-header" {...props} />;
};
