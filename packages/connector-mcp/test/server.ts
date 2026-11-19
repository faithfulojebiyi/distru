/** In-process MCP test server (SDK McpServer over Streamable HTTP on a random Bun port). */
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  meta: Record<string, unknown> | null;
}

type Handler = (args: Record<string, unknown>) => unknown;

export interface TestTool {
  name: string;
  description?: string;
  input: z.ZodObject;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  meta?: Record<string, unknown>;
  handler: Handler;
}

export interface TestServer {
  url: string;
  tools: Map<string, TestTool>;
  calls: ToolCall[];
  headers: Headers[];
  callsTo(name: string): ToolCall[];
  stop(): void;
}

export function startServer(initial: TestTool[]): TestServer {
  const tools = new Map(initial.map((t) => [t.name, t]));
  const calls: ToolCall[] = [];
  const headers: Headers[] = [];
  const handler = createMcpHandler((ctx) => {
    const server = new McpServer({ name: 'test-mcp', version: '1.0.0' });
    for (const t of tools.values()) {
      server.registerTool(
        t.name,
        {
          ...(t.description ? { description: t.description } : {}),
          inputSchema: t.input,
          ...(t.annotations ? { annotations: t.annotations } : {}),
          ...(t.meta ? { _meta: t.meta } : {}),
        },
        async (args: Record<string, unknown>, extra) => {
          const meta = extra && typeof extra === 'object' && 'mcpReq' in extra ? (extra.mcpReq as { _meta?: Record<string, unknown> })._meta ?? null : null;
          calls.push({ name: t.name, args, meta });
          try {
            const out = t.handler(args);
            return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
          } catch (err) {
            return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
          }
        },
      );
    }
    void ctx;
    return server;
  });
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      headers.push(req.headers);
      return handler.fetch(req);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    tools,
    calls,
    headers,
    callsTo: (name) => calls.filter((c) => c.name === name),
    stop: () => {
      void handler.close();
      server.stop(true);
    },
  };
}
