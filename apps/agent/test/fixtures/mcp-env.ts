/**
 * Our MCP server in-process: the Distru mock (REST, via app.request), the Distru connector registry,
 * an in-memory harness, in-memory MCP tokens, the /mcp route on a Hono app, and the MCP SDK client
 * talking Streamable HTTP to it through `app.fetch` (no network, no Postgres).
 */
import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { createDistruContext, distruConnector } from '@ops/connector-distru';
import type { FetchLike } from '@ops/distru-client';
import { createMockServer } from '@ops/distru-mock';
import { createHarness, InMemoryAuditSink, InMemoryProposalStore, Registry, StaticPolicyRules, type PolicyRuleConfig, type Scope } from '@ops/harness';
import { Hono } from 'hono';
import { createMcpHttpRoutes } from '../../src/api/mcp-http';
import type { AuditEvent } from '../../src/api/schemas';
import { requestIdMiddleware } from '../../src/harness/request-context';
import { OpsMcpServers, type OpsMcpDeps } from '../../src/mastra/mcp/ops-mcp';
import { createMcpTokenService, InMemoryMcpTokenStore } from '../../src/services/mcp-tokens';
import { afterDecision, afterPropose, executeApprovedProposal, type SendApproved } from '../../src/mastra/proposal-executor';
import { createDecider, toProposalDetail, toProposalSummary } from '../../src/services/proposals';

export const NOW = '2026-11-19T12:00:00Z';
export const RULES: PolicyRuleConfig[] = [
  { key: 'max_total_value', params: { max: 25_000 } },
  { key: 'auto_approve_below', params: { amount: 500, max_risk: 'medium' } },
  { key: 'allowed_actions', params: { actions: ['distru.purchases.upsert', 'distru.tasks.create'] } },
];

export const approverUser = { id: 'u-approver', name: 'Ana Approver' };

export async function mcpEnv() {
  const mock = createMockServer({ now: NOW });
  const fetch: FetchLike = (url, init) => Promise.resolve(mock.app.request(url, init));
  const distru = createDistruContext({ baseUrl: 'http://mock.test', token: 'mock-token', fetch });
  type Ctx = typeof distru & { run?: { intent?: string } };
  const registry = Registry.fromConnectors([distruConnector]) as Registry<Ctx>;
  const store = new InMemoryProposalStore();
  const audit = new InMemoryAuditSink();
  const harness = createHarness<Ctx>({ registry, store, audit, policyRules: new StaticPolicyRules(RULES) });
  const tokens = createMcpTokenService({ store: new InMemoryMcpTokenStore(), audit });
  const executed: string[] = [];
  // In-process stand-in for Inngest: `ops/proposal.approved` deduped by event id, then the
  // `proposal-execute` body (execute ctx: Distru client without its own retries).
  const executeCtx = createDistruContext({ baseUrl: 'http://mock.test', token: 'mock-token', fetch, maxRetries: 0 });
  const queue = { sent: [] as string[], delivered: new Set<string>() };
  const send: SendApproved = async (proposalId) => {
    queue.sent.push(proposalId);
    if (queue.delivered.has(proposalId)) return;
    queue.delivered.add(proposalId);
    executed.push(proposalId);
    await executeApprovedProposal(harness, { ...executeCtx }, proposalId);
  };
  const noRuns = { resume: async () => false, status: async () => null };
  const decide = createDecider(harness, () => ({ ...distru }), { onDecided: afterDecision({ runs: noRuns, send }) });

  const deps: OpsMcpDeps<Ctx> = {
    registry: () => registry,
    harness,
    ctxFor: (intent) => ({ ...distru, run: { intent } }),
    proposals: {
      list: async ({ status, limit, offset }) =>
        (await store.list(status ? { status } : {}))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
          .slice(offset, offset + limit)
          .map((p) => toProposalSummary(p)),
      get: async (id) => {
        const p = await store.get(id);
        return p ? toProposalDetail(p, await harness.undoInfo(p)) : null;
      },
      // The app's decision path: harness.decide → afterDecision (queue execution of run-less approvals).
      decideAs: async (id, principal, input) => {
        const p = await decide(id, principal, input);
        return toProposalDetail(p, await harness.undoInfo(p));
      },
    },
    audit: {
      sink: audit,
      list: async ({ proposalId, type, order, limit, offset }) => {
        const all = audit.events
          .map((e, i): AuditEvent => ({
            id: e.id,
            seq: i + 1,
            type: e.type,
            actor: e.actor,
            proposalId: e.proposalId,
            opIndex: typeof (e.data as Record<string, unknown>).opIndex === 'number' ? Number((e.data as Record<string, unknown>).opIndex) : null,
            data: e.data,
            at: e.at,
            requestId: null,
            idempotencyKey: null,
            diff: null,
          }))
          .filter((e) => (!proposalId || e.proposalId === proposalId) && (!type || e.type === type));
        if (order === 'desc') all.reverse();
        return all.slice(offset, offset + limit);
      },
    },
    runs: { start: async () => ({ runId: 'run-mcp-1' }), get: async () => null },
    afterPropose: afterPropose(send),
  };
  const servers = new OpsMcpServers(deps);
  const app = new Hono();
  app.use('*', requestIdMiddleware);
  app.route('/', createMcpHttpRoutes({ tokens, servers }));

  const clients: Client[] = [];
  /** An SDK client connected to /mcp with `token` (Streamable HTTP over app.fetch). */
  const connect = async (token: string) => {
    const transport = new StreamableHTTPClientTransport(new URL('http://ops.test/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (url, init) => app.fetch(new Request(url.toString(), init)),
    });
    const client = new Client({ name: 'mcp-test', version: '0.0.0' });
    await client.connect(transport);
    clients.push(client);
    return client;
  };
  const tokenWith = async (name: string, scopes: Scope[]) => (await tokens.create(approverUser, { name, scopes })).token;

  return { mock, distru, registry, store, audit, harness, tokens, servers, app, connect, tokenWith, executed, queue, send, decide, close: async () => Promise.all(clients.map((c) => c.close())) };
}

export type McpEnv = Awaited<ReturnType<typeof mcpEnv>>;

/** Structured content, else JSON text of a tool result. */
export function resultOf(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = (result.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const errorTextOf = (result: CallToolResult) => (result.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('');
