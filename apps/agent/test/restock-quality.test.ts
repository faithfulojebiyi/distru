/**
 * Restock quality, in code: the deterministic demand scan (pre-check before any agent call, retail
 * movers blended with each location's wholesale velocity), SKUs the Analyst misses added in the merge,
 * `flagged_by` computed from the numbers, and the company-wide buyer cap.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { AtRiskSku } from '../src/mastra/agents/inventory-analyst';
import { mergeWithScan, scanDemand, type DemandCandidate } from '../src/mastra/workflows/demand';
import { RestockResultSchema } from '../src/mastra/workflows/restock';
import { restockEnv, type RestockEnv } from './fixtures/restock-env';

async function oakland(env: RestockEnv) {
  return (await env.locations()).find((l) => l.name.startsWith('Oakland'))!;
}

const Vendors = z.object({ vendors: z.array(z.object({ id: z.string(), name: z.string(), lead_time_days: z.number().nullable() })) });

async function scanOakland(env: RestockEnv, productIds?: string[]) {
  const ctx = env.contexts.read;
  const vendors = Vendors.parse(await env.connectors.registry.runReadTool(ctx, env.approver, 'distru.vendors', {})).vendors;
  const loc = await oakland(env);
  return { loc, vendors, scan: await scanDemand({ registry: env.connectors.registry, ctx, locations: [loc], vendors, scope: { productIds } }) };
}

describe('deterministic demand scan', () => {
  test('retail movers are blended with the location velocity in code: PRE-BD-1G (both) and FLW-OGK-35 (retail only) are flagged', async () => {
    const env = await restockEnv();
    const { loc, scan } = await scanOakland(env);
    expect(scan.movers.map((m) => m.sku)).toEqual(expect.arrayContaining(['PRE-BD-1G', 'FLW-OGK-35']));
    const bySku = new Map((scan.byLocation[loc.id] ?? []).map((c) => [c.row.sku, c]));
    expect(bySku.get('PRE-BD-1G')).toMatchObject({ wholesale: true, retail: true, mover: true });
    expect(bySku.get('FLW-OGK-35')).toMatchObject({ wholesale: false, retail: true, signal: { recommendation: 'watch' } });
  });

  test('merge: a SKU the Analyst missed is added from code; flagged_by comes from the numbers, not the model', async () => {
    const env = await restockEnv();
    const { loc, scan } = await scanOakland(env);
    const candidates = scan.byLocation[loc.id] ?? [];
    const ogk = candidates.find((c) => c.row.sku === 'FLW-OGK-35')!;
    // The model reported OGK only, and mislabelled it "wholesale"; it missed PRE-BD-1G entirely.
    const modelSays: AtRiskSku = {
      product_id: ogk.row.product_id,
      sku: 'FLW-OGK-35',
      name: ogk.row.name,
      vendor_id: ogk.row.vendor.id,
      vendor_name: ogk.row.vendor.name,
      location_id: loc.id,
      location_name: loc.name,
      on_hand_available: ogk.row.on_hand_available,
      incoming: 0,
      avg_daily_demand: ogk.row.avg_daily_demand,
      days_of_supply: ogk.row.days_of_supply,
      reorder_status: 'OK',
      suggested_qty: null,
      units_per_case: null,
      open_order_demand: 0,
      adjusted_days_of_supply: null,
      adjusted_avg_daily_demand: null,
      retail_signal: null,
      retail_growth_3w_pct: null,
      recommendation: null,
      flagged_by: 'wholesale',
      urgency_rank: 1,
      reason: 'model reason',
    };
    const merged = mergeWithScan([modelSays], candidates, (_id, name) => name);
    const bySku = new Map(merged.map((m) => [m.sku, m]));
    expect(bySku.get('FLW-OGK-35')).toMatchObject({ flagged_by: 'retail', recommendation: 'watch', retail_signal: 'surging', reason: 'model reason' });
    const pre = bySku.get('PRE-BD-1G')!;
    expect(pre).toMatchObject({ flagged_by: 'both', location_id: loc.id });
    expect(pre.urgency_rank).toBeGreaterThan(1);
    expect(pre.reason).toContain('flagged in code');
    // Every code candidate is present.
    expect(new Set(merged.map((m) => m.product_id))).toEqual(new Set([...candidates.map((c: DemandCandidate) => c.row.product_id)]));
  });
});

describe('pre-check before any agent call', () => {
  test("no-reorder-needed at Oakland: the run ends nothing_to_order and no agent is called", async () => {
    const env = await restockEnv();
    await env.mock.app.request('/__mock/reset', { method: 'POST', body: JSON.stringify({ scenario: 'no-reorder-needed' }), headers: { 'Content-Type': 'application/json' } });
    env.headset.reset('no-reorder-needed');
    const loc = await oakland(env);
    const { scan } = await scanOakland(env);
    expect(scan.byLocation[loc.id]).toEqual([]);

    const { runId } = await env.launcher.start({ triggeredBy: 'test', locationIds: [loc.id] });
    const done = await env.waitFor(runId, ['success']);
    const result = RestockResultSchema.parse(done.result);
    expect(result).toMatchObject({ status: 'nothing_to_order', proposalId: null });
    expect(result.message).toContain('Pre-check');
    const steps = z.record(z.string(), z.object({ output: z.unknown().optional() })).parse(done.steps);
    expect(steps.prepare?.output).toEqual([]);
    expect(steps['analyse-location']?.output ?? []).toEqual([]);
    expect(await env.findProposalByRunId(runId)).toBeNull();
  });
});
