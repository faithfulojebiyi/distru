/**
 * Mock of Distru's MCP server (https://mcp.distru.com/mcp), served at `/mcp` over Streamable HTTP.
 *
 * - @modelcontextprotocol/server 2.x `createMcpHandler`: stateless; a fresh low-level `Server` per
 *   request; serves the 2026-07-28 protocol and falls back to stateless 2025-era serving, so 1.x and
 *   2.x clients both work.
 * - Auth: `Authorization: Bearer distru_mcp_<anything>` (or exactly the configured key); 401 otherwise.
 * - `x-distru-filter-tool-tags: read` hides write tools (from tools/list and tools/call).
 * - Every tool takes `intent` and `userSatisfactionEstimate`; both are logged (store.mcpTelemetry),
 *   and a missing or invalid value doesn't fail the call (mcp_conventions.md).
 * - Per-user limits (mcp_limits.md): HTTP 429 + Retry-After + a JSON-RPC error naming the limit;
 *   `RateLimit-Remaining` / `RateLimit-Reset` on charged calls; a batch of more than 6 tool calls → 400.
 * - Write tools carry `_meta.distru = { kind: 'write', reaches: [...] }` plus MCP annotations.
 */
import { createMcpHandler, Server, type Tool } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Ops } from '../ops';
import type { McpRateLimiter } from '../ratelimit';
import type { Serializer } from '../serialize';
import type { Store } from '../store';
import { IdError } from './ids';
import { TOOL_DEFS, type DistruToolDef, type DistruToolName } from './schemas.gen';
import { HANDLERS, PDF_TOOLS, ToolError, toolCtx, type ToolDetail } from './tools';

export interface McpMockOptions {
  store: () => Store;
  ser: () => Serializer;
  ops: Ops;
  limiter: McpRateLimiter;
  /** exact key to require; default: any `distru_mcp_*` bearer token */
  key?: string;
}

const COMMON_INPUTS = {
  intent: z.string().describe("The user's end goal in one sentence, not this call's."),
  userSatisfactionEstimate: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe('How the request is going so far: 5 on track, 4 minor detour, 3 empty results or a retry, 2 repeated empty or wrong results, 1 stuck or user frustrated.'),
};

/** Writes whose effects can't be taken back (beyond what the host approval dialog shows). */
const IRREVERSIBLE: Record<string, true | string[]> = {
  'distru-mutate-purchase-order': ['DELETE'],
  'distru-mutate-task': ['DELETE'],
  'distru-adjust-inventory': true,
  'distru-email-pdf': true,
};
const DESTRUCTIVE = new Set(['distru-mutate-purchase-order', 'distru-mutate-task', 'distru-adjust-inventory']);

export interface ListedTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Tool['inputSchema'];
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  _meta: { distru: { kind: 'read' | 'write'; reaches: string[]; tags: string[]; irreversible: boolean | string[]; doc: string } };
}

function listing(def: DistruToolDef): ListedTool {
  const { $schema: _drop, ...schema } = z.toJSONSchema(def.input.extend(COMMON_INPUTS), { io: 'input' }) as Record<string, unknown>;
  void _drop;
  const write = def.kind === 'write';
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: { ...schema, type: 'object' } as Tool['inputSchema'],
    annotations: {
      title: def.title,
      readOnlyHint: !write,
      destructiveHint: write && DESTRUCTIVE.has(def.name),
      idempotentHint: !write,
      openWorldHint: def.reaches.length > 0,
    },
    _meta: { distru: { kind: def.kind, reaches: [...def.reaches], tags: [def.kind], irreversible: IRREVERSIBLE[def.name] ?? false, doc: def.doc } },
  };
}

/** The full tool catalogue as tools/list returns it (computed once). */
export const TOOL_LISTING: ListedTool[] = Object.values(TOOL_DEFS).map((d) => listing(d as DistruToolDef));
const LISTING_BY_NAME = new Map(TOOL_LISTING.map((t) => [t.name, t]));

/** Tags requested via `x-distru-filter-tool-tags` (comma-separated), or null for all tools. */
function tagFilter(headers: Headers | undefined): string[] | null {
  const raw = headers?.get('x-distru-filter-tool-tags');
  if (!raw) return null;
  const tags = raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  return tags.length ? tags : null;
}
const visible = (t: ListedTool, tags: string[] | null) => !tags || t._meta.distru.tags.some((x) => tags.includes(x));

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errorResult(message: string, details: ToolDetail[]) {
  const payload = { errors: details.length ? details : [{ message, path: [] }] };
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

export function createMcpRoute(o: McpMockOptions) {
  const userIdFor = () => o.store().apiUserId;

  const handler = createMcpHandler(
    (reqCtx) => {
      const tags = tagFilter(reqCtx.requestInfo?.headers);
      const server = new Server({ name: 'distru-mock', version: '0.1.0', title: 'Distru (mock)' }, { capabilities: { tools: {} }, instructions: 'Mock of the Distru MCP server. Call distru-get-me first.' });

      server.setRequestHandler('tools/list', async () => ({ tools: TOOL_LISTING.filter((t) => visible(t, tags)) }));

      server.setRequestHandler('tools/call', async (req) => {
        const name = req.params.name;
        const listed = LISTING_BY_NAME.get(name);
        if (!listed || !visible(listed, tags)) return errorResult(`Unknown tool: ${name}`, [{ message: `unknown tool ${name}`, path: ['name'] }]);
        const def = TOOL_DEFS[name as DistruToolName] as DistruToolDef;
        const s = o.store();
        const args = (req.params.arguments ?? {}) as Record<string, unknown>;
        const { intent, userSatisfactionEstimate, account: _account, ...rest } = args;
        void _account;
        const intentValid = typeof intent === 'string' && intent.trim().length > 0;
        const satisfactionValid = typeof userSatisfactionEstimate === 'number' && Number.isInteger(userSatisfactionEstimate) && userSatisfactionEstimate >= 1 && userSatisfactionEstimate <= 5;
        const telemetry = {
          at: new Date().toISOString(),
          tool: name,
          user_id: userIdFor(),
          intent: typeof intent === 'string' ? intent : null,
          user_satisfaction_estimate: typeof userSatisfactionEstimate === 'number' ? userSatisfactionEstimate : null,
          intent_valid: intentValid,
          satisfaction_valid: satisfactionValid,
          is_error: false,
        };
        s.mcpTelemetry.push(telemetry);
        if (s.mcpTelemetry.length > 1000) s.mcpTelemetry.splice(0, s.mcpTelemetry.length - 1000);
        if (o.limiter.config.latency_ms > 0) await sleep(o.limiter.config.latency_ms);

        const parsed = def.input.safeParse(rest);
        if (!parsed.success) {
          telemetry.is_error = true;
          const details = parsed.error.issues.map((i) => ({ message: i.message, path: i.path.map((p) => (typeof p === 'symbol' ? String(p) : p)) }));
          return errorResult(`Invalid arguments: ${details.map((d) => `${d.path.join('.') || '(root)'}: ${d.message}`).join('; ')}`, details);
        }
        try {
          const handlerFn = HANDLERS[name as DistruToolName] as (a: unknown, c: ReturnType<typeof toolCtx>) => unknown;
          const result = (await handlerFn(parsed.data, toolCtx(s, o.ser(), o.ops, userIdFor()))) as Record<string, unknown>;
          return server.projectCallToolResult({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }, undefined);
        } catch (e) {
          telemetry.is_error = true;
          if (e instanceof ToolError) return errorResult(e.message, e.details);
          if (e instanceof IdError) return errorResult(e.message, [{ message: e.message, path: e.path }]);
          throw e;
        }
      });
      return server;
    },
    { onerror: (e) => console.error('[distru-mock mcp]', e.message) },
  );

  return async function route(req: Request): Promise<Response> {
    // auth
    const auth = req.headers.get('authorization') ?? '';
    const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() ?? '';
    const ok = o.key ? token === o.key : /^distru_mcp_.+/.test(token);
    if (!ok) {
      return json(
        401,
        { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: authentication failed. Send Authorization: Bearer distru_mcp_<key> (create a key in Distru, or sign in with Distru over OAuth).' } },
        { 'www-authenticate': 'Bearer realm="distru-mcp", error="invalid_token"' },
      );
    }
    if (req.method !== 'POST') return handler.fetch(req);

    const text = await req.text();
    let messages: { id?: unknown; method?: unknown; params?: { name?: unknown } }[] = [];
    try {
      const body = JSON.parse(text) as unknown;
      messages = (Array.isArray(body) ? body : [body]).filter((m): m is (typeof messages)[number] => typeof m === 'object' && m !== null);
    } catch {
      // let the SDK answer the parse error
    }
    const calls = messages.filter((m) => m.method === 'tools/call');
    const forward = () => handler.fetch(new Request(req.url, { method: 'POST', headers: req.headers, body: text }));
    if (!calls.length) return forward();

    const limits = o.limiter;
    if (calls.length > limits.config.max_batch) {
      return json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: `A batch may hold at most ${limits.config.max_batch} tool calls; split it rather than retrying it.` } });
    }
    const credential = token;
    const release = limits.acquire(credential);
    const firstId = calls[0]?.id ?? null;
    if (!release) {
      return json(429, { jsonrpc: '2.0', id: firstId, error: { code: -32029, message: limits.inFlightMessage(), data: { limit: 'max_in_flight', retryAfterSeconds: 1 } } }, { 'retry-after': '1' });
    }
    try {
      const tags = tagFilter(req.headers);
      let quota: { remaining: number; reset: number } | null = null;
      for (const call of calls) {
        const name = typeof call.params?.name === 'string' ? call.params.name : '';
        const listed = LISTING_BY_NAME.get(name);
        if (!listed || !visible(listed, tags)) continue; // answered as unknown tool, not charged
        const res = limits.charge(o.store().apiUserId, listed._meta.distru.kind, PDF_TOOLS.has(name));
        if (!res.ok) {
          const headers: Record<string, string> = { 'retry-after': String(res.retryAfter) };
          if (res.quota) Object.assign(headers, { 'ratelimit-remaining': String(res.quota.remaining), 'ratelimit-reset': String(res.quota.reset) });
          return json(429, { jsonrpc: '2.0', id: call.id ?? null, error: { code: -32029, message: res.message, data: { limit: res.limit, retryAfterSeconds: res.retryAfter } } }, headers);
        }
        quota = { remaining: res.remaining, reset: res.reset };
      }
      const upstream = await forward();
      const body = await upstream.text();
      const headers = new Headers(upstream.headers);
      if (quota) {
        headers.set('ratelimit-remaining', String(quota.remaining));
        headers.set('ratelimit-reset', String(quota.reset));
      }
      return new Response(body, { status: upstream.status, headers });
    } finally {
      release();
    }
  };
}
