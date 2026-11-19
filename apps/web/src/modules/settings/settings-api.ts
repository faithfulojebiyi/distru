import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { listConnectors } from '../../api/generated/connectors/connectors';
import {
  createMcpToken,
  listMcpTokens,
  revokeMcpToken,
} from '../../api/generated/mcp/mcp';
import {
  listPolicyRules,
  updatePolicyRules,
} from '../../api/generated/policy/policy';
import type {
  ConnectorSummary,
  CreateMcpTokenRequest,
  UpdatePolicyRulesRequest,
} from '../../api/generated/opsAgentAPI.schemas';
import { getQueryScope } from '../../lib/query';
import { toast } from '@ops/ui/primitives/toast/toast';

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

/** MCP token and policy rule query keys, built here so invalidation always matches by prefix. */
export const mcpTokenKeys = {
  all: (scope: string) => ['mcp-tokens', scope] as const,
  list: (scope: string) => ['mcp-tokens', scope, 'list'] as const,
};

export const policyKeys = {
  all: (scope: string) => ['policy-rules', scope] as const,
  list: (scope: string) => ['policy-rules', scope, 'list'] as const,
};

/** Per-client MCP tokens (approvers only: an operator gets 403, which the page explains instead of toasting). */
export const useMcpTokens = (enabled: boolean) => {
  const client = useQueryClient();
  return useQuery({
    queryKey: mcpTokenKeys.list(getQueryScope(client)),
    queryFn: ({ signal }) => listMcpTokens({ signal }),
    select: (data) => data.items,
    enabled,
    meta: { suppressErrorToast: true },
  });
};

/** Create a token; the plaintext comes back once, in the mutation result, and is never cached. */
export const useCreateMcpToken = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateMcpTokenRequest) => createMcpToken(body),
    onSuccess: () => void client.invalidateQueries({ queryKey: mcpTokenKeys.all(getQueryScope(client)) }),
    // The form shows the failure inline.
    onError: () => undefined,
  });
};

export const useRevokeMcpToken = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => revokeMcpToken(id),
    onSuccess: (token) => {
      toast.success(`${token.name} revoked. Clients using it stop on their next request.`);
      void client.invalidateQueries({ queryKey: mcpTokenKeys.all(getQueryScope(client)) });
    },
  });
};

/** The policy rule set and the rule types the engine knows (with each type's params JSON Schema). */
export const usePolicyRules = () => {
  const client = useQueryClient();
  return useQuery({
    queryKey: policyKeys.list(getQueryScope(client)),
    queryFn: ({ signal }) => listPolicyRules({ signal }),
    meta: { suppressErrorToast: true },
  });
};

/** Replace the rule set (approvers). A 400 `invalid_policy` carries per-rule issues the form shows inline. */
export const useUpdatePolicyRules = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdatePolicyRulesRequest) => updatePolicyRules(body),
    onSuccess: (data) => {
      client.setQueryData(policyKeys.list(getQueryScope(client)), data);
      toast.success('Policy rules saved. They apply to the next proposal.');
    },
    // The form shows the failure inline.
    onError: () => undefined,
  });
};
