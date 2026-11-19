// Adapted from carbonme modules/integrations/integrations-page.tsx (AppLogo, AppCard, CardGrid, SectionHeading, catalogue).
import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Box, Flex, HStack, styled } from '@ops/ui/jsx';

import type { ConnectorSummary } from '../../api/generated/opsAgentAPI.schemas';
import { Icons } from '@ops/ui/icons/base';
import { IntegrationIcons } from '@ops/ui/icons/integrations';
import { Button } from '@ops/ui/primitives/button';
import { Input } from '@ops/ui/primitives/input';
import { Skeleton } from '@ops/ui/primitives/skeleton';
import { IntegrationEmptyState } from './integration-empty-state';
import { SYSTEM_LABELS, connectorIcon, connectorName, useConnectors } from './settings-api';
import { SettingsPage } from './settings-page';
import { StatusDot } from './status-dot';

/** A connector's mark, never a wordmark: on a white chip on grey cards, and a grey tile on white rows and page heads.
 * A connector with no mark yet shows its initial. */
export const AppLogo = ({
  icon,
  name,
  size = 'md',
}: {
  icon: string;
  /** For the initial when there is no mark. */
  name?: string;
  /** xs: carbonme chat-connector-menu.tsx MenuMark, an 18px tile for single-line menu rows. */
  size?: 'xs' | 'sm' | 'md' | 'lg';
}) => {
  // Literal sizes: Panda only generates classes it can see, so a size picked at runtime collapsed the tile.
  const box = { xs: '18px', sm: '1.75rem', md: '2rem', lg: '3rem' }[size];
  const pixels = { xs: 14, sm: 16, md: 18, lg: 26 }[size];
  const image = icon.startsWith('img:') ? icon.slice(4) : null;
  const Integration =
    icon in IntegrationIcons
      ? IntegrationIcons[icon as keyof typeof IntegrationIcons]
      : null;
  const Base = icon in Icons ? Icons[icon as keyof typeof Icons] : null;
  return (
    <Flex
      aria-hidden
      align="center"
      justify="center"
      flexShrink="0"
      overflow="hidden"
      style={{ width: box, height: box, minWidth: box }}
      rounded={size === 'lg' ? 'xl' : size === 'xs' ? 'sm' : 'lg'}
      color="text.label"
      bg={
        size === 'md' || size === 'xs'
          ? { base: 'background.app', _dark: 'brand.panel.10' }
          : 'brand.panel.4'
      }
      shadow={size === 'xs' ? 'chatChip' : undefined}
    >
      {image ? (
        <styled.img src={image} alt="" style={{ width: pixels, height: pixels }} rounded="sm" objectFit="contain" />
      ) : Integration ? (
        <Integration width={pixels} height={pixels} />
      ) : Base ? (
        <Base size={pixels * 0.85} />
      ) : (
        <styled.span
          fontWeight="600"
          color="text.label"
          style={{ fontSize: pixels * 0.8 }}
        >
          {(name ?? icon).charAt(0).toUpperCase()}
        </styled.span>
      )}
    </Flex>
  );
};

/** Kept for existing imports: the display name from settings-api's connectorName. */
export const connectorTitle = (id: string) => connectorName(id);

const titleOf = (connector: ConnectorSummary) => connectorTitle(connector.id);

/** One connector: the whole card opens its page. */
const ConnectorCard = ({ connector }: { connector: ConnectorSummary }) => (
  <Link
    to="/settings/connectors/$connectorId"
    params={{ connectorId: connector.id }}
    data-connector-card={connector.id}
  >
    <HStack
      gap="3"
      p="3"
      rounded="xl"
      bg="brand.panel.3"
      minW="0"
      transition="background 120ms"
      _hover={{ bg: 'brand.panel.5' }}
      _active={{ bg: 'brand.panel.6' }}
    >
      <AppLogo icon={connectorIcon(connector)} name={titleOf(connector)} />
      <Flex direction="column" minW="0" flex="1" gap="0.5">
        <HStack gap="1.5" minW="0">
          <styled.span fontSize="1.5" fontWeight="600" truncate>
            {titleOf(connector)}
          </styled.span>
          <styled.span
            h="18px"
            px="1.5"
            rounded="md"
            bg="brand.panel.6"
            color="text.muted"
            fontSize="0.688"
            fontWeight="500"
            display="inline-flex"
            alignItems="center"
            flexShrink="0"
          >
            {SYSTEM_LABELS[connector.system] ?? connector.system}
          </styled.span>
          <HStack
            ml="auto"
            gap="1.5"
            fontSize="1"
            color="text.muted"
            flexShrink="0"
            title={connector.health.detail ?? undefined}
          >
            <StatusDot tone={connector.health.ok ? 'green' : 'amber'} />
            {connector.readTools} read · {connector.actions} write
          </HStack>
        </HStack>
        <styled.span fontSize="1" color="text.muted" truncate>
          {connector.health.ok
            ? connector.description
            : (connector.health.detail ?? 'Not reachable')}
        </styled.span>
      </Flex>
    </HStack>
  </Link>
);

const CardGrid = ({ children }: { children: ReactNode }) => (
  <Box
    display="grid"
    gap="2"
    gridTemplateColumns={{
      base: '1fr',
      md: 'repeat(2, minmax(0, 1fr))',
    }}
  >
    {children}
  </Box>
);

const SectionHeading = ({
  tone,
  children,
}: {
  tone: 'green' | 'amber' | 'grey';
  children: ReactNode;
}) => (
  <HStack as="h2" gap="2" fontSize="2" fontWeight="600" mt="8" mb="2.5">
    {children}
    <StatusDot tone={tone} />
  </HStack>
);

/** Settings → Connectors: every connected system, healthy ones first, each opening its tool catalogue. */
export const ConnectorsPage = () => {
  const query = useConnectors();
  const [search, setSearch] = useState('');
  const term = search.trim().toLowerCase();
  const connectors = (query.data ?? []).filter(
    (connector) =>
      !term ||
      connector.id.toLowerCase().includes(term) ||
      connector.description.toLowerCase().includes(term),
  );
  const healthy = connectors.filter((connector) => connector.health.ok);
  const failing = connectors.filter((connector) => !connector.health.ok);
  return (
    <SettingsPage
      title="Connectors"
      description="The systems agents can read from and propose changes to. Every write goes through policy and a human approver."
      width="admin"
    >
      <Box>
        <Box pos="relative">
          <styled.span
            pos="absolute"
            left="2.5"
            top="50%"
            transform="translateY(-50%)"
            color="text.muted"
            display="flex"
            pointerEvents="none"
          >
            <Icons.searchNormal size={14} />
          </styled.span>
          <Input
            aria-label="Search connectors"
            placeholder="Search connectors"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            pl="8"
          />
        </Box>
        {query.isPending ? (
          <Box mt="8">
            <CardGrid>
              {[0, 1].map((key) => (
                <Skeleton key={key} h="16" rounded="xl" />
              ))}
            </CardGrid>
          </Box>
        ) : query.isError ? (
          <HStack gap="3" mt="8" role="alert" fontSize="1.5">
            <styled.span color="text.muted">
              Could not load connectors.
            </styled.span>
            <Button size="xs" variant="soft" onClick={() => void query.refetch()}>
              Try again
            </Button>
          </HStack>
        ) : connectors.length === 0 ? (
          term ? (
            <styled.p color="text.muted" fontSize="1.5" mt="8" role="status">
              No connectors match “{search.trim()}”.
            </styled.p>
          ) : (
            <Box mt="8" role="status">
              <IntegrationEmptyState
                roomy
                title="No connectors registered"
                detail="Connectors are registered on the agent server. Add one with the add-connector skill."
              />
            </Box>
          )
        ) : (
          <>
            {healthy.length > 0 && (
              <section aria-label="Connected">
                <SectionHeading tone="green">Connected</SectionHeading>
                <CardGrid>
                  {healthy.map((connector) => (
                    <ConnectorCard key={connector.id} connector={connector} />
                  ))}
                </CardGrid>
              </section>
            )}
            {failing.length > 0 && (
              <section aria-label="Not reachable">
                <SectionHeading tone="amber">Not reachable</SectionHeading>
                <CardGrid>
                  {failing.map((connector) => (
                    <ConnectorCard key={connector.id} connector={connector} />
                  ))}
                </CardGrid>
              </section>
            )}
          </>
        )}
      </Box>
    </SettingsPage>
  );
};
