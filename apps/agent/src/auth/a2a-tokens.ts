import type { McpTokenService } from '../services/mcp-tokens';
import type { A2ATokenResolver } from './mastra-auth';

/**
 * A2A (Mastra's built-in `/api/.well-known/:agentId/agent-card.json` + `/api/a2a/:agentId`) accepts
 * the same per-client tokens as /mcp, besides a Better Auth session:
 * - the agent card needs any valid token;
 * - execution needs `propose` (the Ops Lead can start a restock run, which creates a proposal).
 * The caller becomes a pseudo-user `mcp-token:<id>` with the operator role (never approver: A2A
 * cannot decide anything), so memory threads / runs are owned by that token.
 */
export function a2aTokenResolver(tokens: Pick<McpTokenService, 'authenticate'>): A2ATokenResolver {
  return async (token, { path }) => {
    const client = await tokens.authenticate(token);
    if (!client) return null;
    if (path.startsWith('/api/a2a/') && !client.principal.scopes.includes('propose')) return null;
    return { id: `mcp-token:${client.token.id}`, email: `mcp-token-${client.token.id}@tokens.ops-agent.local`, name: client.token.name, role: 'operator' };
  };
}
