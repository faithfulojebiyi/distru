/** Distru preset: `distru-adjust-inventory` hooks (Metrc sync checked by read-back) against a fake Distru MCP server. */
import { afterEach, describe, expect, test } from 'bun:test';
import { agentPrincipal, createHarness, InMemoryAuditSink, InMemoryProposalStore, Registry, sequentialIds, StaticPolicyRules, userPrincipal } from '@ops/harness';
import { z } from 'zod';
import { createDistruMcpConnector, mcpErrorClassifier } from '../src';
import { startServer, type TestServer } from './server';

const operator = agentPrincipal('ops-lead');
const approver = userPrincipal('u-approver', 'approver');
const common = { intent: z.string().min(1), userSatisfactionEstimate: z.number().int().min(1).max(5) };

interface Activity {
  id: string;
  packageId: string;
  status: 'COMPLETED' | 'FAILED' | 'QUEUED';
  lastError: string | null;
}

/** Distru saves every adjustment; Metrc rejects the next `failNext` package adjustments. */
function fakeDistru() {
  const adjustments: Array<{ id: string; packageId: string | null; quantity: number }> = [];
  const activities: Activity[] = [];
  const metrc = { failNext: 0 };
  const server = startServer([
    {
      name: 'distru-adjust-inventory',
      input: z.object({ packageId: z.string().optional(), batchId: z.string().optional(), quantity: z.union([z.string(), z.number()]), complianceReason: z.string().optional(), description: z.string().optional(), reason: z.string().optional(), ...common }),
      handler: (a) => {
        const id = `adj_${adjustments.length + 1}`;
        const packageId = typeof a.packageId === 'string' ? a.packageId : null;
        adjustments.push({ id, packageId, quantity: Number(a.quantity) });
        let complianceActivity: Activity | null = null;
        if (packageId) {
          const fail = metrc.failNext > 0;
          if (fail) metrc.failNext--;
          complianceActivity = { id: String(310000 + activities.length + 1), packageId, status: fail ? 'FAILED' : 'COMPLETED', lastError: fail ? 'Package quantity in Metrc does not match' : null };
          activities.push(complianceActivity);
        }
        return { stockAdjustment: { id, quantity: String(a.quantity), complianceActivity } };
      },
    },
    {
      name: 'distru-search-metrc-activities',
      input: z.object({ packageIds: z.array(z.string()).optional(), statuses: z.array(z.string()).optional(), sortBy: z.object({ field: z.string(), direction: z.string() }).optional(), limit: z.number().optional(), ...common }),
      handler: (a) => {
        const pkgs = Array.isArray(a.packageIds) ? a.packageIds : null;
        const statuses = Array.isArray(a.statuses) ? a.statuses : null;
        const items = activities
          .filter((x) => (!pkgs || pkgs.includes(x.packageId)) && (!statuses || statuses.includes(x.status)))
          .reverse()
          .map((x) => ({ id: x.id, type: 'ADJUST_PACKAGE', status: x.status, lastError: x.lastError, package: { id: x.packageId } }));
        return { items, hasMore: false, totalCount: items.length };
      },
    },
  ]);
  return { adjustments, activities, metrc, server };
}

let server: TestServer | null = null;
afterEach(() => {
  server?.stop();
  server = null;
});

async function setup() {
  const fake = fakeDistru();
  server = fake.server;
  const bridge = await createDistruMcpConnector({ url: fake.server.url, key: 'distru_mcp_test' });
  const registry = Registry.fromConnectors([bridge.connector]);
  const harness = createHarness({ registry, store: new InMemoryProposalStore(), audit: new InMemoryAuditSink(), ids: sequentialIds('p'), policyRules: new StaticPolicyRules([]), errors: mcpErrorClassifier });
  return { ...fake, bridge, registry, harness, ctx: { ...bridge.context, run: { intent: 'Write off crushed units' } } };
}

const damage = { packageId: 'pkg_7', quantity: -2, complianceReason: 'Damage', description: 'Crushed in transit' };

async function approved(env: Awaited<ReturnType<typeof setup>>, input: Record<string, unknown> = damage) {
  const p = await env.harness.propose({ ctx: env.ctx, principal: operator, ops: [{ action: 'distru_mcp.adjust_inventory', input }] });
  return env.harness.decide({ ctx: env.ctx, principal: approver, proposalId: p.id, decision: 'approve' });
}

describe('Distru MCP preset: adjust-inventory (Metrc-bound)', () => {
  test('high risk (reaches Metrc), verified, not undoable; the summary names the delta and the Metrc sync', async () => {
    const env = await setup();
    const action = env.registry.action('distru_mcp.adjust_inventory');
    expect(action.risk).toBe('high');
    expect(env.bridge.tools.find((t) => t.tool === 'distru-adjust-inventory')).toMatchObject({ unverified: false, dedupeByExecutorOnly: true });
    expect(action.irreversible).toContain("can't be edited or undone");
    const p = await approved(env);
    expect(p.ops[0]?.summary).toBe('Adjust package pkg_7 by -2 (Damage), synced to Metrc');
  });

  test('Metrc accepts it: executed with the adjustment id as record id', async () => {
    const env = await setup();
    const p = await approved(env);
    const done = await env.harness.execute({ ctx: env.ctx, proposalId: p.id });
    expect(done.status).toBe('executed');
    expect(done.ops[0]?.result).toMatchObject({ recordId: 'adj_1', mismatches: [], error: null });
  });

  test('Metrc rejects it after Distru saved: op failed with the Metrc error, record kept; resume never adjusts twice and passes once Metrc syncs', async () => {
    const env = await setup();
    env.metrc.failNext = 1;
    const p = await approved(env);
    const failed = await env.harness.execute({ ctx: env.ctx, proposalId: p.id });
    expect(failed.status).toBe('failed');
    expect(failed.ops[0]?.result).toMatchObject({ recordId: 'adj_1', error: { name: 'VerificationFailed' } });
    expect(failed.ops[0]?.result?.mismatches).toEqual([
      { path: ['metrc', 'status'], expected: 'COMPLETED', actual: 'FAILED' },
      { path: ['metrc', 'lastError'], expected: null, actual: 'Package quantity in Metrc does not match' },
    ]);
    expect(env.adjustments).toHaveLength(1);

    const again = await env.harness.execute({ ctx: env.ctx, proposalId: p.id });
    expect(again.status).toBe('failed');
    expect(env.adjustments).toHaveLength(1);

    // retried in Distru once the package was fixed in Metrc
    for (const a of env.activities) Object.assign(a, { status: 'COMPLETED', lastError: null });
    const done = await env.harness.execute({ ctx: env.ctx, proposalId: p.id });
    expect(done.status).toBe('executed');
    expect(done.ops[0]?.result).toMatchObject({ recordId: 'adj_1', deduplicated: true, mismatches: [] });
    expect(env.adjustments).toHaveLength(1);
  });

  test('a batch adjustment reaches no state system and verifies as written', async () => {
    const env = await setup();
    env.metrc.failNext = 1;
    const p = await approved(env, { batchId: 'bat_3', quantity: -5, reason: 'WASTE' });
    const done = await env.harness.execute({ ctx: env.ctx, proposalId: p.id });
    expect(done.status).toBe('executed');
  });
});
