/**
 * Thin wrapper over the MCP SDK client (Streamable HTTP) that the bridge's hooks use.
 *
 * Safety property: `callRead` refuses any tool whose *current* classification is not `read`, so a
 * write tool can never be reached through a read tool, even if the server reclassifies a tool after
 * the registry was built. Writes only go through `callWrite`, which only the bridge's write actions
 * call from the harness executor (after approval).
 */
import { Client, StreamableHTTPClientTransport, type AuthProvider, type CallToolResult, type FetchLike, type Tool } from '@modelcontextprotocol/client';
import { classifyTool, type ClassifyFn, type McpToolInfo, type ToolClassification, type ToolTable } from './classify';

export const IDEMPOTENCY_META_KEY = 'ops-agent/idempotency-key';

export interface McpAuth {
  /** Static bearer token (`Authorization: Bearer …`), e.g. a `distru_mcp_…` key. */
  bearer?: string;
  /** Full SDK auth provider (OAuth etc.). */
  provider?: AuthProvider;
}

export interface McpClientOptions {
  url: string | URL;
  headers?: Record<string, string>;
  auth?: McpAuth;
  /** Read-only mode: sends `readOnlyHeader` and the bridge builds no write actions. */
  readOnly?: boolean;
  /** Header(s) that ask the server to hide write tools, e.g. `{ 'x-distru-filter-tool-tags': 'read' }`. */
  readOnlyHeader?: Record<string, string>;
  classify?: ClassifyFn;
  table?: ToolTable;
  fetch?: FetchLike;
  clientInfo?: { name: string; version: string };
  /** Per-request timeout (ms). */
  timeoutMs?: number;
}

/** An MCP tool returned `isError: true` (validation failure, permission error, business rule…). */
export class McpToolError extends Error {
  readonly tool: string;
  readonly result: CallToolResult;
  constructor(tool: string, result: CallToolResult) {
    super(`MCP tool ${tool} failed: ${textOf(result).slice(0, 500) || 'error'}`);
    this.name = 'McpToolError';
    this.tool = tool;
    this.result = result;
  }
}

/** Raised when a call would cross the read/write boundary. Never retryable. */
export class McpBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpBoundaryError';
  }
}

export function textOf(result: CallToolResult): string {
  return (result.content ?? [])
    .map((c) => (c.type === 'text' ? c.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** Structured content, else JSON in the text content, else `{ text }`. */
export function parseResult(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = textOf(result);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

export const toToolInfo = (t: Tool): McpToolInfo => ({
  name: t.name,
  title: t.title ?? t.annotations?.title,
  description: t.description,
  inputSchema: { ...t.inputSchema },
  annotations: t.annotations,
  _meta: t._meta,
});

export class McpBridgeClient {
  readonly options: McpClientOptions;
  #client: Client | null = null;
  #connecting: Promise<Client> | null = null;
  #tools: McpToolInfo[] | null = null;
  #classes = new Map<string, ToolClassification>();
  /** Every `tools/call` made (name + arguments), for tests and debugging. */
  readonly calls: Array<{ name: string; arguments: Record<string, unknown>; meta?: Record<string, unknown> }> = [];

  constructor(options: McpClientOptions) {
    this.options = options;
  }

  get readOnly(): boolean {
    return this.options.readOnly === true;
  }

  async #connect(): Promise<Client> {
    if (this.#client) return this.#client;
    this.#connecting ??= (async () => {
      const headers = { ...(this.options.headers ?? {}), ...(this.readOnly ? (this.options.readOnlyHeader ?? {}) : {}) };
      const bearer = this.options.auth?.bearer;
      if (bearer && !this.options.auth?.provider) headers.Authorization = `Bearer ${bearer}`;
      const transport = new StreamableHTTPClientTransport(new URL(this.options.url), {
        requestInit: { headers },
        ...(this.options.auth?.provider ? { authProvider: this.options.auth.provider } : {}),
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      });
      const client = new Client(this.options.clientInfo ?? { name: 'ops-agent-mcp-bridge', version: '0.0.0' });
      try {
        await client.connect(transport);
      } catch (err) {
        this.#connecting = null;
        throw err;
      }
      this.#client = client;
      return client;
    })();
    return this.#connecting;
  }

  #requestOptions() {
    return this.options.timeoutMs ? { timeout: this.options.timeoutMs } : {};
  }

  /** `tools/list` (all pages). Cached; `refresh` re-fetches and re-classifies. */
  async listTools(refresh = false): Promise<McpToolInfo[]> {
    if (this.#tools && !refresh) return this.#tools;
    const client = await this.#connect();
    const { tools } = await client.listTools(undefined, { ...this.#requestOptions(), cacheMode: refresh ? 'refresh' : 'use' });
    this.#tools = tools.map(toToolInfo);
    this.#classes = new Map(this.#tools.map((t) => [t.name, classifyTool(t, { classify: this.options.classify, table: this.options.table })]));
    return this.#tools;
  }

  /** Classification of a tool from the latest `tools/list` (undefined when unknown). */
  classificationOf(name: string): ToolClassification | undefined {
    return this.#classes.get(name);
  }

  async #call(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<CallToolResult> {
    const client = await this.#connect();
    this.calls.push({ name, arguments: args, ...(meta ? { meta } : {}) });
    const result = await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) }, this.#requestOptions());
    if (result.isError) throw new McpToolError(name, result);
    return result;
  }

  /** Call a tool that is currently classified `read`. Anything else is refused. */
  async callRead(name: string, args: Record<string, unknown>): Promise<unknown> {
    let c = this.classificationOf(name);
    if (!c) {
      await this.listTools(true);
      c = this.classificationOf(name);
    }
    if (!c) throw new McpBoundaryError(`MCP tool ${name} is not offered by the server`);
    if (c.kind !== 'read') throw new McpBoundaryError(`MCP tool ${name} is classified as a write and cannot be called as a read tool`);
    return parseResult(await this.#call(name, args));
  }

  /**
   * Call a write tool with the harness idempotency key in `_meta`. Only the bridge's write actions
   * call this, from the harness executor, after approval.
   */
  async callWrite(name: string, args: Record<string, unknown>, idempotencyKey: string): Promise<{ result: CallToolResult; parsed: unknown }> {
    if (this.readOnly) throw new McpBoundaryError(`MCP bridge is read-only; refusing to call ${name}`);
    const result = await this.#call(name, args, { [IDEMPOTENCY_META_KEY]: idempotencyKey });
    return { result, parsed: parseResult(result) };
  }

  async close(): Promise<void> {
    const c = this.#client;
    this.#client = null;
    this.#connecting = null;
    if (c) await c.close();
  }
}

/** Transport-level failures worth retrying: HTTP 429 / 5xx from the MCP endpoint. */
export function isRetryableMcpError(err: unknown): boolean {
  if (err instanceof McpToolError || err instanceof McpBoundaryError) return false;
  const status = typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number' ? err.status : undefined;
  return status !== undefined && (status === 429 || status >= 500);
}
