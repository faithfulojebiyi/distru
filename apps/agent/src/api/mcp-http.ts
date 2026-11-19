/**
 * `/mcp`: our MCP server over Streamable HTTP (Claude Code, Codex, any MCP client).
 *
 *   Authorization: Bearer ops_mcp_…   (POST /api/mcp-tokens; approver-created, scoped, revocable)
 *   → token → mcpClientPrincipal(tokenId, scopes)
 *   → the MCPServer for that scope set (its tool list is the principal's)
 *   → MCPServer.startHTTP with the principal as the request's MCP `authInfo`
 *
 * Better Auth sessions are not accepted here (an MCP client is its own principal, with its own
 * scopes and audit identity). The fetch ↔ Node conversion mirrors @mastra/hono's MCP route.
 */
import type { MCPServer } from '@mastra/mcp';
import type { Scope } from '@ops/harness';
import { toFetchResponse, toReqRes } from 'fetch-to-node';
import { Hono } from 'hono';
import { currentRequestId } from '../harness/request-context';
import type { McpCaller } from '../mastra/mcp/ops-mcp';
import { bearerOf, type McpTokenService } from '../services/mcp-tokens';

export const MCP_PATH = '/mcp';

export interface McpHttpDeps {
  tokens: Pick<McpTokenService, 'authenticate'>;
  servers: { forScopes(scopes: readonly Scope[]): MCPServer };
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

const unauthorized = (message: string) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }), {
    status: 401,
    headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="ops-agent-mcp"' },
  });

export function createMcpHttpRoutes(deps: McpHttpDeps) {
  const app = new Hono();

  app.on(['GET', 'POST', 'DELETE'], MCP_PATH, async (c) => {
    const token = bearerOf(c.req.header('authorization'));
    const client = await deps.tokens.authenticate(token);
    if (!client || !token) return unauthorized('Unauthorized: send Authorization: Bearer <ops_mcp_… token> (create one under Settings → MCP tokens)');

    const server = deps.servers.forScopes(client.principal.scopes);
    const { req, res } = toReqRes(c.req.raw);
    const caller: McpCaller = {
      principal: client.principal,
      tokenId: client.token.id,
      tokenName: client.token.name,
      requestId: currentRequestId() ?? crypto.randomUUID(),
    };
    // The MCP Node transport forwards `req.auth` as the request's authInfo (tools read it as context.mcp.extra.authInfo).
    Object.assign(req, { auth: { token, clientId: client.token.id, scopes: client.principal.scopes, extra: caller } });

    server.startHTTP({ url: new URL(c.req.url), httpPath: MCP_PATH, req, res }).catch((err: unknown) => {
      deps.log?.('MCP request failed', { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
      }
    });
    // A client that disconnects must stop the transport's SSE keep-alive (same as @mastra/hono).
    c.req.raw.signal.addEventListener('abort', () => res.emit('close'), { once: true });
    return toFetchResponse(res);
  });

  return app;
}
