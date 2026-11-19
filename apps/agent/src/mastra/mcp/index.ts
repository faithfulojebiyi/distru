/**
 * MCP servers (https://mastra.ai/reference/project-structure → src/mastra/mcp).
 *
 * Our own MCP server is `ops-mcp.ts`: @mastra/mcp `MCPServer`s (one per token scope set) whose tools
 * are generated from the harness registry for the caller's principal, plus proposal / audit / run
 * tools. They are NOT registered on the Mastra instance: Mastra's registered-server routes would
 * authenticate with a Better Auth session, while an MCP client is its own principal with a scoped,
 * revocable token. They are served at /mcp by `src/api/mcp-http.ts` (token → principal → server).
 */
export const mcpServers = {};
