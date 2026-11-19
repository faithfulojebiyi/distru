/**
 * MCP servers (https://mastra.ai/reference/project-structure → src/mastra/mcp).
 *
 * Our own MCP server lives here: permission-scoped tools (`read`, `propose`, `approve`) generated
 * from the same harness registry, so Claude Code / Codex get exactly the safety guarantees the UI
 * has (`approve_proposal` calls `harness.decide` with the MCP client's principal). Registered in
 * src/mastra/index.ts as `mcpServers`.
 */
export const mcpServers = {};
