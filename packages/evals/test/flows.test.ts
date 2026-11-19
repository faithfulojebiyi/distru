import '../src/env-defaults';
import { describe, expect, test } from 'bun:test';
import { agentPrincipal } from '@ops/harness';
import { z } from 'zod';
import { scriptedModel } from '../../../apps/agent/test/fixtures/scripted-model';
import { vendorLiaisonScript } from '../../../apps/agent/test/fixtures/vendor-liaison-script';
import { AGENT_KEYS, type AgentKey } from '../../../apps/agent/src/mastra/agents/roster';
import { evaluateAll } from '../src/assertions';
import { emptyObservation } from '../src/observation';
import { deliverDistruWebhooks, placeOrderAndCapture, runVendorReply } from '../src/runner';
import { scenarioById } from '../src/scenarios';
import type { Scenario } from '../src/scenario';
import { createWorld } from '../src/world';
import { SLACK_MEMBERS } from '../src/emulators';

/**
 * The plumbing behind the new (not yet recorded) scenarios, with scripted models instead of
 * recordings: the vendor-reply flow through apps/emulators, Slack clicks on an approval message, and
 * Distru webhook redelivery dedupe. The recorded runs then only add the real model's behaviour.
 */
const PRICING = { inputUsdPerMTok: 3, outputUsdPerMTok: 15 };
const scripted = () => Object.fromEntries(AGENT_KEYS.map((k) => [k, scriptedModel(k, vendorLiaisonScript)])) as Record<AgentKey, ReturnType<typeof scriptedModel>>;
const scenario = (id: string): Scenario => {
  const s = scenarioById(id);
  if (!s) throw new Error(`no scenario ${id}`);
  return s;
};
/** The checks that don't depend on what a real model costs or which tools it chose. */
const deterministic = (s: Scenario) => s.expectations.filter((a) => a.kind !== 'cost_below_usd');

describe('vendor reply via apps/emulators (scripted Vendor Liaison)', () => {
  test('partial shipment: every scenario check holds; the Gmail ids are listed as volatile', async () => {
    const s = scenario('vendor-reply-partial-shipment');
    const world = await createWorld({ scenario: s, models: scripted(), pricing: PRICING, emulators: { composio: true } });
    try {
      const o = emptyObservation('vendor_reply');
      await runVendorReply(world, s, o);
      const failing = evaluateAll(deterministic(s), o).filter((r) => r.status !== 'pass');
      expect(failing).toEqual([]);
      expect(world.emu?.volatile().length).toBeGreaterThan(0);
    } finally {
      await world.close();
    }
  }, 60_000);

  test('injection: flagged, no proposal, nothing written', async () => {
    const s = scenario('vendor-reply-injection');
    const world = await createWorld({ scenario: s, models: scripted(), pricing: PRICING, emulators: { composio: true } });
    try {
      const o = emptyObservation('vendor_reply');
      await runVendorReply(world, s, o);
      expect(evaluateAll(deterministic(s), o).filter((r) => r.status !== 'pass')).toEqual([]);
    } finally {
      await world.close();
    }
  }, 60_000);
});

describe('Slack approval clicks (Slack emulator)', () => {
  test('operator refused with an ephemeral, approver decides', async () => {
    const s = scenario('slack-approval-operator-refused');
    const world = await createWorld({ scenario: s, models: scripted(), pricing: PRICING, emulators: { slack: true } });
    try {
      const product = z.object({ id: z.string(), vendor: z.object({ id: z.string() }), unit_cost: z.number() }).parse(
        await world.connectors.registry.runReadTool(world.contexts.read, world.approver, 'distru.products_get', { sku: 'FLW-BD-35' }),
      );
      const oakland = (await world.locations()).find((l) => l.name.startsWith('Oakland'))!;
      const proposal = await world.harness.propose({
        ctx: world.contexts.read,
        principal: agentPrincipal('procurement-planner'),
        title: 'Restock Blue Dream',
        ops: [{ action: 'distru.purchases.upsert', input: { vendor_id: product.vendor.id, location_id: oakland.id, lines: [{ product_id: product.id, quantity: 240, unit_price: product.unit_cost }] } }],
      });
      expect(proposal.status).toBe('pending_approval');
      await world.emu!.slack!.proposalCreated(proposal);
      const refused = await world.emu!.clickSlack(SLACK_MEMBERS.operator, proposal, 'proposal_approve');
      expect(refused.outcome).toBe('refused');
      expect(refused.message ?? '').toMatch(/only approvers/i);
      expect((await world.harness.get(proposal.id)).status).toBe('pending_approval');
      const decided = await world.emu!.clickSlack(SLACK_MEMBERS.approver, proposal, 'proposal_approve');
      expect(decided.outcome).toBe('decided');
      expect((await world.harness.get(proposal.id)).decision).toMatchObject({ decision: 'approve', by: { id: 'u-adam' } });
    } finally {
      await world.close();
    }
  }, 60_000);
});

describe('Distru webhook redelivery', () => {
  test('the same ORDER CREATE delivered twice is accepted twice with one event id → one run', async () => {
    const s = scenario('webhook-replay-dedupe');
    const world = await createWorld({ scenario: s, models: scripted(), pricing: PRICING, distruWebhooks: true });
    try {
      const hooks = await placeOrderAndCapture(world, 'Oakland', [{ sku: 'PRE-BD-1G', quantity: 50 }]);
      const started: string[][] = [];
      const deliveries = await deliverDistruWebhooks(world, hooks, 2, async (order) => {
        started.push(order.productIds);
      });
      expect(deliveries.map((d) => d.status)).toEqual(['accepted', 'accepted']);
      expect(deliveries[0]?.eventId).toBe(deliveries[1]?.eventId ?? 'different');
      expect(started).toHaveLength(1);
      expect(started[0]).toEqual([await world.productId('PRE-BD-1G')]);
      // a forged copy is rejected and starts nothing
      const forged = await deliverDistruWebhooks(world, [{ raw: hooks[0]!.raw, headers: new Headers({ 'x-distru-signature': 'sha256=00' }) }], 1, async () => {
        started.push([]);
      });
      expect(forged[0]?.status).toBe('rejected');
      expect(started).toHaveLength(1);
    } finally {
      await world.close();
    }
  }, 60_000);
});
