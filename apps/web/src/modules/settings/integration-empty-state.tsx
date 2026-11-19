// Copied from carbonme modules/integrations/integration-empty-state.tsx.
import { Flex, styled } from '@ops/ui/jsx';

export const IntegrationEmptyState = ({
  title,
  detail,
  roomy = false,
}: {
  title: string;
  detail: string;
  roomy?: boolean;
}) => (
  <Flex
    direction="column"
    align="center"
    gap="1.5"
    py={roomy ? '12' : '10'}
    rounded="xl"
    bg="brand.panel.3"
    textAlign="center"
  >
    <styled.p fontSize="1.5" fontWeight="600">
      {title}
    </styled.p>
    <styled.p fontSize="1" color="text.muted" maxW="24rem">
      {detail}
    </styled.p>
  </Flex>
);
