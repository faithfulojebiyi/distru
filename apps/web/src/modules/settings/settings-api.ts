import { useQuery, useQueryClient } from '@tanstack/react-query';

import { listConnectors } from '../../api/generated/connectors/connectors';
import type { ConnectorSummary } from '../../api/generated/opsAgentAPI.schemas';
import { getQueryScope } from '../../lib/query';

/** Every connector query key, built here so invalidation always matches by prefix. */
export const connectorKeys = {
  all: (scope: string) => ['connectors', scope] as const,
  list: (scope: string) => ['connectors', scope, 'list'] as const,
};

/** Connected systems with live health and their tool catalogue; health is re-checked every 30s. */
export const useConnectors = () => {
  const client = useQueryClient();
  return useQuery({
    queryKey: connectorKeys.list(getQueryScope(client)),
    queryFn: ({ signal }) => listConnectors({ signal }),
    select: (data) => data.items,
    meta: { suppressErrorToast: true },
    refetchInterval: 30_000,
  });
};

/** The kind of system a connector reaches, as a short badge. */
export const SYSTEM_LABELS: Record<string, string> = {
  erp: 'ERP',
  commerce: 'Commerce',
  email: 'Email',
  analytics: 'Analytics',
  crm: 'CRM',
  mcp: 'MCP',
  other: 'Other',
};

/** Display names for connector ids; ids are registry keys ("distru_mcp"), never shown raw. */
const CONNECTOR_NAMES: Record<string, string> = {
  distru: 'Distru',
  distru_mcp: 'Distru MCP',
  headset: 'Headset',
  email: 'Email',
  composio: 'Composio',
};

/** A connector's name as people read it: "Distru MCP", "Headset"; unknown ids are title-cased word by word. */
export const connectorName = (id: string) =>
  CONNECTOR_NAMES[id] ??
  id
    .split(/[_-]/)
    .filter(Boolean)
    .map((word) => (word.toLowerCase() === 'mcp' ? 'MCP' : `${word.charAt(0).toUpperCase()}${word.slice(1)}`))
    .join(' ');

/** A connector's mark: an integration icon when one exists, else a base icon for its kind of system. */
export const connectorIcon = (connector: Pick<ConnectorSummary, 'id' | 'system'>) => {
  if (connector.id === 'email') return 'gmail';
  if (connector.id === 'distru' || connector.id === 'distru_mcp') return 'img:/integrations/distru.png';
  if (connector.id === 'headset') return 'img:/integrations/headset.png';
  switch (connector.system) {
    case 'erp':
      return 'database';
    case 'analytics':
      return 'chartBars';
    case 'commerce':
      return 'tag';
    case 'email':
      return 'sms';
    case 'mcp':
      return 'tools';
    default:
      return 'integrations';
  }
};
