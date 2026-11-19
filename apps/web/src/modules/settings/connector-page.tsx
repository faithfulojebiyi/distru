// Adapted from carbonme modules/integrations/mcp-connector-page.tsx (ConnectorHero, Callout, ToolGroup, ToolRow).
import { useState, type ReactNode } from 'react';
import { Box, Flex, HStack, styled } from '@ops/ui/jsx';

import type {
  ConnectorTool,
  Risk,
} from '../../api/generated/opsAgentAPI.schemas';
import { Icons } from '@ops/ui/icons/base';
import { Skeleton } from '@ops/ui/primitives/skeleton';
import { AppLogo, connectorTitle } from './connectors-page';
import { SYSTEM_LABELS, connectorIcon, useConnectors } from './settings-api';
import { SettingsPage } from './settings-page';

const FIRST_TOOLS = 8;

const RISK_TONES: Record<NonNullable<Risk>, { bg: string | { base: string; _dark: string }; color: string }> = {
  low: { bg: 'palette.green.3', color: 'palette.green.11' },
  medium: { bg: { base: 'palette.orange.3', _dark: 'palette.amber.3' }, color: 'palette.amber.11' },
  high: { bg: 'brand.error.3', color: 'text.error' },
};

const Pill = ({
  bg = 'brand.panel.6',
  color = 'text.muted',
  children,
}: {
  bg?: string | { base: string; _dark: string };
  color?: string;
  children: ReactNode;
}) => (
  <styled.span
    h="18px"
    px="1.5"
    rounded="md"
    bg={bg}
    color={color}
    fontSize="0.688"
    fontWeight="500"
    display="inline-flex"
    alignItems="center"
    flexShrink="0"
    whiteSpace="nowrap"
  >
    {children}
  </styled.span>
);

/** One tool: its harness name and what it does; on the right the scope it needs and, for a write, its risk. */
const ToolRow = ({ tool }: { tool: ConnectorTool }) => (
  <HStack
    gap="3"
    px="3"
    py="2.5"
    rounded="lg"
    bg={{ base: 'background.app', _dark: 'brand.panel.4' }}
    data-tool={tool.toolName}
  >
    <Box minW="0" flex="1">
      <HStack gap="1.5">
        <styled.span fontSize="1.5" fontWeight="600" fontFamily="mono" truncate>
          {tool.name}
        </styled.span>
      </HStack>
      {tool.description && (
        <styled.p fontSize="1" color="text.muted" lineClamp="2" title={tool.description}>
          {tool.description}
        </styled.p>
      )}
    </Box>
    <HStack gap="1.5" flexShrink="0">
      {tool.risk && (
        <Pill bg={RISK_TONES[tool.risk].bg} color={RISK_TONES[tool.risk].color}>
          {tool.risk} risk
        </Pill>
      )}
      <Pill>{tool.requiredScope}</Pill>
    </HStack>
  </HStack>
);

const ToolRows = ({
  tools,
  all,
  setAll,
}: {
  tools: ConnectorTool[];
  all: boolean;
  setAll: (value: boolean) => void;
}) => {
  const shown = all ? tools : tools.slice(0, FIRST_TOOLS);

  return (
    <>
      {shown.map((tool) => (
        <ToolRow key={tool.toolName} tool={tool} />
      ))}
      {tools.length > FIRST_TOOLS && (
        <styled.button
          type="button"
          textAlign="left"
          px="3"
          h="9"
          fontSize="1.5"
          color="text.muted"
          cursor="pointer"
          _hover={{ color: 'text.app' }}
          onClick={() => setAll(!all)}
        >
          {all
            ? 'Show fewer tools'
            : `Show ${tools.length - FIRST_TOOLS} more tools`}
        </styled.button>
      )}
    </>
  );
};

/** Read tools or write actions, collapsible. */
const ToolGroup = ({
  title,
  note,
  tools,
}: {
  title: string;
  note: string;
  tools: ConnectorTool[];
}) => {
  const [open, setOpen] = useState(true);

  const [all, setAll] = useState(false);

  if (tools.length === 0) {
    return null;
  }

  return (
    <Flex
      direction="column"
      gap="1"
      p="1.5"
      rounded="xl"
      bg="brand.panel.3"
      data-tool-group={title}
    >
      <HStack px="2" h="10" gap="2">
        <styled.button
          type="button"
          display="flex"
          alignItems="center"
          gap="2"
          cursor="pointer"
          fontSize="1.5"
          fontWeight="500"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <styled.span
            color="text.muted"
            transform={open ? 'none' : 'rotate(-90deg)'}
            transition="transform 120ms"
            display="flex"
          >
            <Icons.caretDown size={12} />
          </styled.span>
          {title}
          <styled.span color="text.muted">{tools.length}</styled.span>
        </styled.button>
        <styled.span ml="auto" fontSize="1" color="text.muted" truncate>
          {note}
        </styled.span>
      </HStack>
      {open && <ToolRows tools={tools} all={all} setAll={setAll} />}
    </Flex>
  );
};

const CALLOUT_BACKGROUNDS = {
  red: 'brand.error.3',
  amber: { base: 'palette.orange.3', _dark: 'palette.amber.3' },
  grey: 'brand.panel.4',
} as const;

const CALLOUT_COLORS = {
  red: 'text.error',
  amber: 'palette.amber.11',
  grey: 'text.muted',
} as const;

/** A tinted note: an error with its fix, or what the harness guarantees. */
const Callout = ({
  tone,
  children,
}: {
  tone: keyof typeof CALLOUT_BACKGROUNDS;
  children: ReactNode;
}) => (
  <HStack
    gap="2.5"
    alignItems="start"
    px="3"
    py="2.5"
    rounded="lg"
    fontSize="1.5"
    bg={CALLOUT_BACKGROUNDS[tone]}
    role={tone === 'red' ? 'alert' : undefined}
  >
    <styled.span mt="0.5" color={CALLOUT_COLORS[tone]}>
      <Icons.infoCircle size={14} />
    </styled.span>
    <Box flex="1" minW="0">
      {children}
    </Box>
  </HStack>
);

/** Settings → Connectors → one connector: its health, read tools and propose-only write actions. */
export const ConnectorPage = ({ connectorId }: { connectorId: string }) => {
  const query = useConnectors();
  const connector = query.data?.find((item) => item.id === connectorId);
  const name = connectorTitle(connectorId);

  return (
    <SettingsPage
      title={name}
      description=""
      width="admin"
      trail={[{ label: 'Connectors', to: '/settings/connectors' }]}
      heading={
        <HStack gap="4" alignItems="center">
          <AppLogo
            icon={connector ? connectorIcon(connector) : 'integrations'}
            name={name}
            size="lg"
          />
          <Box minW="0" flex="1">
            <HStack gap="2">
              <styled.h1 fontSize="5.5" fontWeight="600" letterSpacing="-0.01em">
                {name}
              </styled.h1>
              {connector && (
                <Pill>{SYSTEM_LABELS[connector.system] ?? connector.system}</Pill>
              )}
            </HStack>
            <styled.p fontSize="1.5" color="text.muted" mt="0.5">
              {connector?.description ?? 'Loading…'}
            </styled.p>
          </Box>
        </HStack>
      }
    >
      {query.isPending ? (
        <Skeleton h="40" rounded="xl" />
      ) : !connector ? (
        <Callout tone="red">
          {query.isError
            ? 'Could not load connectors. Check that the agent server is running.'
            : `No connector named ${connectorId} is registered.`}
        </Callout>
      ) : (
        <>
          {connector.health.ok ? (
            <Callout tone="grey">
              Healthy{connector.health.detail ? `: ${connector.health.detail}` : ''}.
              Agents only read through these tools; write actions create a
              proposal that policy and a human approver must pass.
            </Callout>
          ) : (
            <Callout tone="amber">
              Not reachable{connector.health.detail ? `: ${connector.health.detail}` : ''}.
              Runs that need it fail until it answers again.
            </Callout>
          )}
          <ToolGroup
            title="Read tools"
            note="read scope · every agent"
            tools={connector.tools.filter((tool) => tool.kind === 'read')}
          />
          <ToolGroup
            title="Write actions"
            note="propose scope · Procurement Planner only · applied by the executor"
            tools={connector.tools.filter((tool) => tool.kind === 'action')}
          />
        </>
      )}
    </SettingsPage>
  );
};
