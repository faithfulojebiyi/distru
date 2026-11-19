/**
 * MCP smoke test against the running server, with the MCP SDK client (what Claude Code / Codex do):
 *
 *   approver signs in → creates an `ops_mcp_…` token (read + propose) → SDK client connects to /mcp
 *   → tools/list → get_me → a read tool (distru_products_get) → propose_distru_purchases_upsert
 *   → list_proposals → get_proposal (diff) → the token is revoked again.
 *
 * Nothing is written to Distru: the proposal waits for a human in Approvals.
 *
 *   bun run mcp:smoke                       # creates and revokes a throwaway token
 *   MCP_TOKEN=ops_mcp_… bun run mcp:smoke   # use an existing token (not revoked)
 *
 * Prereqs: Postgres + seed, `bun run dev:mock` (:4500), the agent server (:4111).
 * Env: AGENT_URL (default http://localhost:4111), MCP_TOKEN, APPROVER_EMAIL / DEMO_PASSWORD.
 */
import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client';

const BASE = process.env.AGENT_URL ?? 'http://localhost:4111';
const ORIGIN = 'http://localhost:3050';
const c = { dim: (s: string) => `\x1b[2m${s}\x1b[0m`, bold: (s: string) => `\x1b[1m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`, red: (s: string) => `\x1b[31m${s}\x1b[0m` };

function fail(msg: string, detail?: unknown): never {
  console.error(c.red(`✗ ${msg}`));
  if (detail !== undefined) console.error(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2).slice(0, 3000));
  process.exit(1);
}

async function api(path: string, init: RequestInit = {}, bearer?: string) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...init.headers },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: res.status, body, headers: res.headers };
}

const textOf = (r: CallToolResult) => (r.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('');
function parsed(r: CallToolResult): Record<string, unknown> {
  if (r.isError) fail('tool error', textOf(r));
  const data: unknown = r.structuredContent ?? JSON.parse(textOf(r) || 'null');
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('unexpected tool result', data);
  return data as Record<string, unknown>;
}

// ── token ────────────────────────────────────────────────────────────────────────────────────
let token = process.env.MCP_TOKEN ?? '';
let session = '';
let createdId: string | null = null;
if (!token) {
  const signIn = await api('/api/auth/sign-in/email', { method: 'POST', body: JSON.stringify({ email: process.env.APPROVER_EMAIL ?? 'approver@demo.dev', password: process.env.DEMO_PASSWORD ?? 'demo-password' }) });
  session = signIn.headers.get('set-auth-token') ?? '';
  if (signIn.status !== 200 || !session) fail(`approver sign-in failed (${signIn.status}); is the server up and seeded?`, signIn.body);
  const created = await api('/api/mcp-tokens', { method: 'POST', body: JSON.stringify({ name: 'mcp-smoke', scopes: ['read', 'propose'] }) }, session);
  if (created.status !== 201) fail(`POST /api/mcp-tokens → ${created.status}`, created.body);
  const body = created.body as { token: string; record: { id: string; scopes: string[] }; mcpUrl: string };
  token = body.token;
  createdId = body.record.id;
  console.log(`${c.green('✓')} token created (${body.record.scopes.join('+')}) for ${body.mcpUrl}`);
}

// ── MCP client ───────────────────────────────────────────────────────────────────────────────
const client = new Client({ name: 'ops-mcp-smoke', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
try {
  const { tools } = await client.listTools();
  console.log(`${c.green('✓')} tools/list: ${tools.length} tools`);
  console.log(c.dim(`  ${tools.map((t) => t.name).join(', ')}`));

  const me = parsed(await client.callTool({ name: 'get_me', arguments: { intent: 'MCP smoke test: bootstrap' } }));
  console.log(`${c.green('✓')} get_me: ${JSON.stringify(me.principal)}`);

  const product = parsed(await client.callTool({ name: 'distru_products_get', arguments: { intent: 'MCP smoke test: look up Blue Dream 3.5g', sku: 'FLW-BD-35' } }));
  const vendor = product.vendor as { id: string; name: string } | null;
  if (!vendor) fail('FLW-BD-35 has no vendor', product);
  console.log(`${c.green('✓')} distru_products_get: ${String(product.name)} from ${vendor.name}`);

  const locations = await api('/api/locations', {}, session || undefined);
  let locationId: string | null = null;
  if (locations.status === 200) locationId = ((locations.body as { items: Array<{ id: string }> }).items[0] ?? null)?.id ?? null;
  if (!locationId) {
    const inv = parsed(await client.callTool({ name: 'distru_inventory', arguments: { intent: 'MCP smoke test: find a receiving location', product_ids: [String(product.id)] } }));
    const rows = (inv.items ?? inv.rows ?? []) as Array<{ location?: { id: string } | null }>;
    locationId = rows.find((r) => r.location)?.location?.id ?? null;
  }
  if (!locationId) fail('no location id found (sign in or pass MCP_TOKEN with a server that has GET /api/locations)');

  const proposal = parsed(
    await client.callTool({
      name: 'propose_distru_purchases_upsert',
      arguments: { intent: 'MCP smoke test: propose a small Blue Dream restock', vendor_id: vendor.id, location_id: locationId, lines: [{ product_id: String(product.id), quantity: 60, unit_price: 14 }], notes: 'mcp:smoke' },
    }),
  );
  console.log(`${c.green('✓')} propose: ${c.bold(String(proposal.proposalId))} → ${String(proposal.status)} (policy: ${JSON.stringify((proposal.policy as { outcome: string }).outcome)})`);
  for (const op of proposal.ops as Array<{ summary: string; diff: string }>) console.log(c.dim(`  ${op.summary}\n  ${op.diff.split('\n').join('\n  ')}`));

  const list = parsed(await client.callTool({ name: 'list_proposals', arguments: { intent: 'MCP smoke test: inbox', limit: 3 } }));
  console.log(`${c.green('✓')} list_proposals: ${(list.items as unknown[]).length} item(s), hasMore=${String(list.hasMore)}`);
  const detail = parsed(await client.callTool({ name: 'get_proposal', arguments: { intent: 'MCP smoke test: review', id: String(proposal.proposalId) } }));
  console.log(`${c.green('✓')} get_proposal: status ${String(detail.status)}, undo available=${String((detail.undo as { available: boolean }).available)}`);
  console.log(`\nNothing was written to Distru: approve or reject ${String(proposal.proposalId)} in Approvals.`);
} finally {
  await client.close();
  if (createdId) {
    const revoked = await api(`/api/mcp-tokens/${createdId}`, { method: 'DELETE' }, session);
    console.log(revoked.status === 200 ? `${c.green('✓')} token revoked` : c.red(`token revoke → ${revoked.status}`));
  }
}
