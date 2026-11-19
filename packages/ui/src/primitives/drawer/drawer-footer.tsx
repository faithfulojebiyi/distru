import { Flex, type FlexProps } from '@ops/ui/jsx';

export const DrawerFooter = ({ ...props }: FlexProps) => {
  return <Flex direction="column" gap="2" mt="auto" px="4" py="4" {...props} />;
};
