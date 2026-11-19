/**
 * The restock workflow end to end, in-process: the Distru mock (no network), the real connector and
 * registry, an in-memory harness, the five agents on scripted models, and the workflow on Mastra's
 * default engine with in-memory storage.
 */
import { Mastra } from '@mastra/core';
import { InMemoryStore } from '@mastra/core/storage';
import { distruErrorClassifier } from '@ops/connector-distru';
import type { FetchLike } from '@ops/distru-client';
import { createMockServer, FAILED_TEST_SKU, INJECTION_SKU } from '@ops/distru-mock';
import { agentPrincipal, createHarness, InMemoryAuditSink, InMemoryProposalStore, StaticPolicyRules, type PolicyRuleConfig } from '@ops/harness';
import { z } from 'zod';
import { buildAppContexts, appRegistry } from '../../src/harness/registry';
import { createAgents } from '../../src/mastra/agents';
import type { AgentKey } from '../../src/mastra/agents/roster';
import { RestockLauncher, RESTOCK_WORKFLOW_KEY } from '../../src/mastra/restock-launcher';
import { createRestockWorkflowInProcess, type RestockDeps } from '../../src/mastra/workflows/restock';
import { jsonAfter, match, resultOf, resultsOf, scriptedModel, type Script } from './scripted-model';

export const NOW = '2026-11-19T12:00:00Z';
export { FAILED_TEST_SKU, INJECTION_SKU };

export const DEFAULT_RULES: PolicyRuleConfig[] = [
  { key: 'max_total_value', params: { max: 25_000 } },
  { key: 'auto_approve_below', params: { amount: 500, max_risk: 'medium' } },
  { key: 'high_risk_requires_approval', params: {} },
  { key: 'allowed_actions', params: { actions: ['distru.purchases.upsert'] } },
];

const PURCHASES_PATH = '/public/v1/purchases';

// ── agent scripts ────────────────────────────────────────────────────────────────────────────────

const VelocityRow = z.object({
  product_id: z.string(),
  sku: z.string(),
  name: z.string(),
  vendor: z.object({ id: z.string(), name: z.string() }),
  location: z.object({ id: z.string(), name: z.string() }).nullable(),
  on_hand_available: z.number(),
  incoming: z.number(),
  avg_daily_demand: z.number(),
  days_of_supply: z.number().nullable(),
  reorder_status: z.string(),
  suggested_qty: z.number().nullable(),
  units_per_case: z.number().nullable(),
});

interface AtRisk {
  product_id: string;
  sku: string;
  vendor_id: string;
  location_id: string | null;
  suggested_qty: number | null;
  units_per_case: number | null;
}

const analystScript: Script = ({ prompt, results, step }) => {
  const locationId = match(prompt, /location_id ([\w-]+)/)!;
  if (step === 0) {
    return { tools: [{ name: 'distru_velocity_report', args: { below_reorder_point: true, location_ids: [locationId], lead_time_days: 14, limit: 100 } }] };
  }
  const scope = jsonAfter<string[]>(prompt, 'Scope: only these product ids:');
  const rows = z.array(VelocityRow).parse(resultOf(results, 'distru_velocity_report')?.rows ?? []);
  const atRisk = rows
    .filter((r) => ['LATE', 'ORDER_NOW', 'ORDER_SOON'].includes(r.reorder_status))
    .filter((r) => !scope || scope.includes(r.product_id))
    .slice(0, 10)
    .map((r, i) => ({
      product_id: r.product_id,
      sku: r.sku,
      name: r.name,
      vendor_id: r.vendor.id,
      vendor_name: r.vendor.name,
      location_id: r.location?.id ?? locationId,
      location_name: r.location?.name ?? null,
      on_hand_available: r.on_hand_available,
      incoming: r.incoming,
      avg_daily_demand: r.avg_daily_demand,
      days_of_supply: r.days_of_supply,
      reorder_status: r.reorder_status,
      suggested_qty: r.suggested_qty,
      units_per_case: r.units_per_case,
      open_order_demand: 0,
      urgency_rank: i + 1,
      reason: `${r.days_of_supply ?? 'n/a'} days of supply (${r.reorder_status})`,
    }));
  return { final: { location_id: locationId, at_risk: atRisk, summary: `${atRisk.length} SKU(s) at risk`, suspicious_text: [] } };
};

export interface PlannerBehaviour {
  /** Order 5,000 units of the injected SKU, as the injected text demands (first plan only). */
  obeyInjection?: boolean;
  /** Override the planned quantity (default: suggested_qty, or 10). */
  quantity?: (item: AtRisk) => number;
  /** How a revision changes the draft: back to suggested quantities, or one unit of the first line only. */
  revise?: 'suggested' | 'shrink';
}

const PriceSummary = z.array(z.object({ product_id: z.string(), last_unit_price: z.number() }));
const PurchaseInput = z.object({
  vendor_id: z.string(),
  location_id: z.string(),
  lines: z.array(z.object({ product_id: z.string(), quantity: z.number(), unit_price: z.number() })),
  notes: z.string().optional(),
});

function plannerScript(behaviour: PlannerBehaviour): Script {
  return ({ prompt, results, step }) => {
    const vendorId = match(prompt, /vendor_id ([\w-]+)/)!;
    const final = (lines: unknown[]) => ({ final: { vendor_id: vendorId, summary: `Planned ${lines.length} line(s)`, lines, suspicious_text: [] } });

    if (prompt.startsWith('REVISION')) {
      const items = jsonAfter<AtRisk[]>(prompt, 'At-risk SKUs for context:') ?? [];
      const previous = z.array(z.object({ input: PurchaseInput })).parse(jsonAfter(prompt, 'Your current draft POs:') ?? []);
      if (step === 0) {
        return {
          tools: previous.map(({ input }) => {
            const lines =
              behaviour.revise === 'shrink'
                ? input.lines.slice(0, 1).map((l) => ({ ...l, quantity: 1 }))
                : input.lines.map((l) => ({ ...l, quantity: items.find((i) => i.product_id === l.product_id)?.suggested_qty ?? l.quantity }));
            return { name: 'propose_distru_purchases_upsert', args: { ...input, lines, notes: 'Revised per policy feedback' } };
          }),
        };
      }
      return final([]);
    }

    const items = jsonAfter<AtRisk[]>(prompt, 'At-risk SKUs (from the Inventory Analysts):') ?? [];
    if (step === 0) {
      return { tools: [{ name: 'distru_vendor_purchase_history', args: { vendor_id: vendorId, product_ids: items.map((i) => i.product_id) } }] };
    }
    if (step === 1) {
      const prices = PriceSummary.parse(resultOf(results, 'distru_vendor_purchase_history')?.price_summary ?? []);
      const byLocation = new Map<string, AtRisk[]>();
      for (const item of items) byLocation.set(item.location_id ?? '?', [...(byLocation.get(item.location_id ?? '?') ?? []), item]);
      const calls = [...byLocation.entries()].flatMap(([locationId, group]) => {
        const lines = group.flatMap((item) => {
          const price = prices.find((p) => p.product_id === item.product_id)?.last_unit_price;
          if (price === undefined) return [];
          const quantity = behaviour.obeyInjection && item.sku === INJECTION_SKU ? 5000 : (behaviour.quantity?.(item) ?? item.suggested_qty ?? 10);
          return [{ product_id: item.product_id, quantity, unit_price: price }];
        });
        return lines.length ? [{ name: 'propose_distru_purchases_upsert', args: { vendor_id: vendorId, location_id: locationId, lines, notes: 'Restock' } }] : [];
      });
      return calls.length ? { tools: calls } : final([]);
    }
    return final(items.map((i) => ({ product_id: i.product_id, sku: i.sku, location_id: i.location_id ?? '?', decision: 'ordered', quantity: i.suggested_qty ?? 0, unit_price: null, reason: 'suggested quantity' })));
  };
}

const ComplianceProducts = z.array(z.object({ product_id: z.string(), sku: z.string().nullable(), status: z.string(), reasons: z.array(z.string()) }));

const reviewerScript: Script = ({ prompt, results, step }) => {
  const lines = jsonAfter<Array<{ product_id: string }>>(prompt, 'Review these draft purchase order lines:') ?? [];
  const ids = [...new Set(lines.map((l) => l.product_id))];
  if (step === 0) return { tools: [{ name: 'distru_compliance_check', args: { product_ids: ids } }] };
  if (step === 1) return { tools: ids.map((product_id) => ({ name: 'distru_products_get', args: { product_id } })) };
  const products = ComplianceProducts.parse(resultOf(results, 'distru_compliance_check')?.products ?? []);
  const suspicious = resultsOf(results, 'distru_products_get').flatMap((p) => {
    const d = z.object({ untrusted_text: z.string(), source: z.string(), suspicious: z.boolean() }).nullable().safeParse(p.description);
    if (!d.success || !d.data?.suspicious) return [];
    return [{ product_id: String(p.id), sku: typeof p.sku === 'string' ? p.sku : null, source: d.data.source, excerpt: d.data.untrusted_text.slice(0, 120), note: 'Instruction-like text in the product description; ignored.' }];
  });
  return {
    final: {
      lines: products.map((p) => ({ product_id: p.product_id, sku: p.sku, verdict: p.status === 'blocked' ? 'veto' : 'approve', reasons: p.reasons.length ? p.reasons : [`status ${p.status}`] })),
      summary: `${products.filter((p) => p.status === 'blocked').length} product(s) vetoed`,
      suspicious_text: suspicious,
    },
  };
};

const criticScript: Script = ({ prompt }) => {
  const ops = jsonAfter<Array<{ vendor_id: string | null }>>(prompt, 'Draft POs:') ?? [];
  const evaluation = jsonAfter<{ reasons: Array<{ rule: string; outcome: string; message: string }> }>(prompt, 'Policy evaluation:');
  const denied = evaluation?.reasons.filter((r) => r.outcome === 'deny') ?? [];
  const vendors = [...new Set(ops.map((o) => o.vendor_id).filter((v): v is string => Boolean(v)))];
  return {
    final: {
      explanation: denied.map((r) => `${r.rule}: ${r.message}`).join('; '),
      revisions: vendors.map((vendor_id) => ({ vendor_id, instruction: 'Bring the draft within policy: use analysed quantities and fit the cap.' })),
      summary: `${denied.length} deny finding(s)`,
    },
  };
};

const opsLeadScript: Script = () => ({ text: 'I can start a restock run for you.' });

// ── environment ──────────────────────────────────────────────────────────────────────────────────

export interface RestockEnvOptions {
  rules?: PolicyRuleConfig[];
  planner?: PlannerBehaviour;
}

export function restockEnv(options: RestockEnvOptions = {}) {
  const mock = createMockServer({ now: NOW });
  const net = { purchaseWrites: 0 };
  const fetch: FetchLike = async (url, init) => {
    const res = await mock.app.request(url, init);
    if ((init?.method ?? 'GET').toUpperCase() === 'POST' && new URL(url).pathname === PURCHASES_PATH && res.ok) net.purchaseWrites++;
    return res;
  };
  const contexts = buildAppContexts({ baseUrl: 'http://mock.test', token: 'mock-token', fetch });
  const store = new InMemoryProposalStore();
  const audit = new InMemoryAuditSink();
  const rules = new StaticPolicyRules(options.rules ?? DEFAULT_RULES);
  const harness = createHarness({ registry: appRegistry, store, audit, policyRules: rules, errors: distruErrorClassifier, random: () => 0.5 });
  const findProposalByRunId = async (runId: string) => (await store.list()).find((p) => p.meta.workflowRunId === runId) ?? null;

  const deps: RestockDeps = {
    registry: appRegistry,
    harness,
    policyRules: rules,
    contexts: () => contexts,
    pricing: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
    findProposalByRunId,
  };

  const scripts: Record<AgentKey, Script> = {
    opsLead: opsLeadScript,
    inventoryAnalyst: analystScript,
    procurementPlanner: plannerScript(options.planner ?? {}),
    complianceReviewer: reviewerScript,
    policyCritic: criticScript,
  };
  const models = Object.fromEntries(Object.entries(scripts).map(([k, s]) => [k, scriptedModel(k, s)])) as Record<AgentKey, ReturnType<typeof scriptedModel>>;

  const launcher = new RestockLauncher();
  const agents = createAgents({ registry: appRegistry, harness, readCtx: () => contexts.read, models, launcher });
  const mastra = new Mastra({
    agents,
    workflows: { [RESTOCK_WORKFLOW_KEY]: createRestockWorkflowInProcess(deps) },
    storage: new InMemoryStore(),
    logger: false,
  });
  launcher.bind(mastra);

  const approver = { kind: 'user' as const, id: 'u-approver', scopes: ['read' as const, 'propose' as const, 'approve' as const], label: 'Ana Approver' };
  const planner = agentPrincipal('procurement-planner');

  /** Product ids by SKU (via the connector, as an agent would see them). */
  const productId = async (sku: string) => {
    const p = z.object({ id: z.string() }).parse(await appRegistry.runReadTool(contexts.read, planner, 'distru.products_get', { sku }));
    return p.id;
  };
  const locations = async () => {
    const all = await contexts.read.connectors.distru.listAll(contexts.read.connectors.distru.listLocations, {});
    return all.map((l) => ({ id: l.id, name: l.name ?? l.id }));
  };

  /** Polls Mastra run storage until the run reaches one of `statuses`. */
  const waitFor = async (runId: string, statuses: string[], timeoutMs = 20_000) => {
    const started = Date.now();
    for (;;) {
      const state = await launcher.workflow().getWorkflowRunById(runId);
      if (state && statuses.includes(state.status)) return state;
      if (state?.status === 'failed' && !statuses.includes('failed')) throw new Error(`run failed: ${state.error?.message ?? JSON.stringify(state.steps)}`);
      if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${statuses.join('|')} (last: ${state?.status})`);
      await Bun.sleep(25);
    }
  };

  return { mock, net, contexts, store, audit, rules, harness, deps, agents, mastra, launcher, approver, productId, locations, waitFor, findProposalByRunId };
}

export type RestockEnv = ReturnType<typeof restockEnv>;
