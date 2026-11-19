/**
 * The restock workflow end to end, in-process, with no network and no live servers: the Distru mock
 * (REST *and* its MCP endpoint, through `app.request`), the Headset mock, the mock email outbox, the
 * real connectors and app registry (built by `AppConnectors`, MCP bridge from a live in-process
 * tools/list), an in-memory harness with the app policy engine, the five agents on scripted models,
 * and the workflow on Mastra's default engine with in-memory storage.
 */
import { Mastra } from '@mastra/core';
import { InMemoryStore } from '@mastra/core/storage';
import { OutboxTransport } from '@ops/connector-email';
import { createDistruMcpConnector } from '@ops/connector-mcp';
import type { FetchLike } from '@ops/distru-client';
import { createMockServer, FAILED_TEST_SKU, INJECTION_SKU } from '@ops/distru-mock';
import { createHeadsetMock } from '@ops/headset-mock';
import { agentPrincipal, createHarness, InMemoryAuditSink, InMemoryProposalStore, StaticPolicyRules, type PolicyRuleConfig } from '@ops/harness';
import { z } from 'zod';
import { appPolicyEngine, DEFAULT_ALLOWED_ACTIONS, DEFAULT_EMAIL_DOMAINS } from '../../src/harness/policy';
import { AppConnectors, appErrorClassifier, buildAppContexts } from '../../src/harness/registry';
import type { CrossToolOptions } from '../../src/mastra/workflows/cross-tool';
import { createAgents } from '../../src/mastra/agents';
import type { AgentKey } from '../../src/mastra/agents/roster';
import { RestockLauncher, RESTOCK_WORKFLOW_KEY } from '../../src/mastra/restock-launcher';
import { createRestockWorkflowInProcess, type RestockDeps } from '../../src/mastra/workflows/restock';
import { jsonAfter, match, resultOf, resultsOf, scriptedModel, type Script } from './scripted-model';
import type { ComposioBridge } from '@ops/connector-composio';
import type { ProposalNotifier } from '../../src/slack/approvals';
import { VENDOR_REPLY_WORKFLOW_KEY } from '../../src/mastra/restock-launcher';
import { createVendorReplyWorkflowInProcess, type VendorReplyDeps } from '../../src/mastra/workflows/vendor-reply';
import { vendorLiaisonScript } from './vendor-liaison-script';

export const NOW = '2026-11-19T12:00:00Z';
export { FAILED_TEST_SKU, INJECTION_SKU };

/** Same rules as the seed (src/db/seed.ts). */
export const DEFAULT_RULES: PolicyRuleConfig[] = [
  { key: 'max_total_value', params: { max: 25_000 } },
  { key: 'auto_approve_below', params: { amount: 500, max_risk: 'medium' } },
  { key: 'high_risk_requires_approval', params: {} },
  { key: 'allowed_actions', params: { actions: DEFAULT_ALLOWED_ACTIONS } },
  { key: 'email_recipient_domains', params: { domains: DEFAULT_EMAIL_DOMAINS, onViolation: 'deny' } },
];

const PURCHASES_PATH = '/public/v1/purchases';
const TASKS_PATH = '/public/v1/tasks';
export const MCP_KEY = 'distru_mcp_mock';

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

const TrendRow = z.object({ sku: z.string(), signal: z.string(), oos_trend: z.string() });
const Demand = z.object({
  sku: z.string().nullable(),
  adjusted_days_of_supply: z.number().nullable(),
  adjusted_avg_daily: z.number(),
  recommendation: z.enum(['reorder_now', 'watch', 'ok']),
  retail: z.object({ signal: z.enum(['surging', 'rising', 'flat', 'declining', 'no_data']), growth_3w_pct: z.number().nullable() }),
  reasons: z.array(z.string()),
});
const WHOLESALE_AT_RISK = ['LATE', 'ORDER_NOW', 'ORDER_SOON'];

/**
 * Follows the Analyst's instructions with real tool calls: wholesale velocity (below and above the
 * reorder point) → retail trends → demand_signal for wholesale candidates and retail movers → at-risk
 * SKUs flagged by wholesale, retail or both.
 */
const analystScript: Script = ({ prompt, results, step }) => {
  const locationId = match(prompt, /location_id ([\w-]+)/)!;
  const scope = jsonAfter<string[]>(prompt, 'Scope: only these product ids:');
  const leadTimes = jsonAfter<Array<{ vendor_id: string; lead_time_days: number | null }>>(prompt, 'Vendor lead times (days):') ?? [];
  const leadOf = (vendorId: string) => leadTimes.find((v) => v.vendor_id === vendorId)?.lead_time_days ?? 14;
  if (step === 0) {
    return {
      tools: [
        { name: 'distru_velocity_report', args: { below_reorder_point: true, location_ids: [locationId], lead_time_days: 14, limit: 100 } },
        { name: 'distru_velocity_report', args: { below_reorder_point: false, location_ids: [locationId], lead_time_days: 14, limit: 100 } },
      ],
    };
  }
  const rows = resultsOf(results, 'distru_velocity_report')
    .flatMap((r) => z.array(VelocityRow).parse(r.rows ?? []))
    .filter((r) => !scope || scope.includes(r.product_id));
  if (step === 1) return rows.length ? { tools: [{ name: 'headset_retail_trends', args: { skus: rows.map((r) => r.sku).slice(0, 50) } }] } : { final: { location_id: locationId, at_risk: [], summary: 'nothing in scope', suspicious_text: [] } };
  const trends = z.array(TrendRow).parse(resultOf(results, 'headset_retail_trends')?.rows ?? []);
  const candidates = rows.filter((r) => {
    const t = trends.find((x) => x.sku === r.sku);
    return WHOLESALE_AT_RISK.includes(r.reorder_status) || t?.signal === 'surging' || t?.signal === 'rising' || t?.oos_trend === 'rising';
  });
  if (step === 2 && candidates.length) {
    return {
      tools: candidates.map((r) => ({
        name: 'headset_demand_signal',
        args: { sku: r.sku, wholesale_days_of_supply: r.days_of_supply === null ? null : Math.max(0, r.days_of_supply), wholesale_avg_daily: r.avg_daily_demand, lead_time_days: leadOf(r.vendor.id) },
      })),
    };
  }
  const demand = resultsOf(results, 'headset_demand_signal').flatMap((d) => {
    const parsed = Demand.safeParse(d);
    return parsed.success ? [parsed.data] : [];
  });
  const atRisk = candidates
    .map((r) => ({ r, d: demand.find((x) => x.sku === r.sku) ?? null, wholesale: WHOLESALE_AT_RISK.includes(r.reorder_status) }))
    .filter(({ d, wholesale }) => wholesale || d?.recommendation === 'reorder_now' || d?.recommendation === 'watch')
    .sort((a, b) => (a.d?.recommendation === 'reorder_now' ? 0 : 1) - (b.d?.recommendation === 'reorder_now' ? 0 : 1) || (a.d?.adjusted_days_of_supply ?? a.r.days_of_supply ?? 1e9) - (b.d?.adjusted_days_of_supply ?? b.r.days_of_supply ?? 1e9))
    .slice(0, 12)
    .map(({ r, d, wholesale }, i) => ({
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
      adjusted_days_of_supply: d?.adjusted_days_of_supply ?? null,
      adjusted_avg_daily_demand: d?.adjusted_avg_daily ?? null,
      retail_signal: d?.retail.signal ?? null,
      retail_growth_3w_pct: d?.retail.growth_3w_pct ?? null,
      recommendation: d?.recommendation ?? null,
      flagged_by: wholesale ? (d && d.recommendation !== 'ok' && d.retail.signal !== 'flat' ? 'both' : 'wholesale') : 'retail',
      urgency_rank: i + 1,
      reason: `Distru: ${r.days_of_supply ?? 'n/a'} days of supply (${r.reorder_status}). Headset: ${d ? `${d.retail.signal} ${d.retail.growth_3w_pct ?? 0}% → ${d.adjusted_days_of_supply ?? 'n/a'} adjusted days (${d.recommendation})` : 'no retail lookup'}.`,
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
  /** Ignore the allocation-guard suggestions (the workflow must backfill them). */
  skipCaps?: boolean;
  /** Propose this cap instead of the suggested one (the plan guard must deny it). */
  capOverride?: number;
}

const GuardLine = z.array(z.object({ product_id: z.string(), cap: z.number() }));

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
      // The draft holds POs and (allocation guard) caps; only the POs are re-proposed with new lines.
      const previous = z
        .array(z.object({ input: z.unknown() }))
        .parse(jsonAfter(prompt, 'Your current draft POs:') ?? [])
        .flatMap(({ input }) => {
          const po = PurchaseInput.safeParse(input);
          return po.success ? [{ input: po.data }] : [];
        });
      if (step === 0) {
        return {
          tools: previous.map(({ input }): { name: string; args: Record<string, unknown> } => {
            const lines =
              behaviour.revise === 'shrink'
                ? input.lines.slice(0, 1).map((l) => ({ ...l, quantity: 1 }))
                : input.lines.map((l) => ({ ...l, quantity: items.find((i) => i.product_id === l.product_id)?.suggested_qty ?? l.quantity }));
            return { name: 'propose_distru_purchases_upsert', args: { ...input, lines, notes: 'Revised per policy feedback' } };
          }).concat(GuardLine.parse(jsonAfter(prompt, 'exact cap):') ?? []).map((g) => ({ name: 'propose_distru_mcp_mutate_product', args: { action: 'UPDATE', id: g.product_id, maxMenuBuyerOrderQuantity: g.cap } }))),
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
          // A "watch" SKU with nothing to order is skipped (the instructions' formula gives <= 0).
          return quantity > 0 ? [{ product_id: item.product_id, quantity, unit_price: price }] : [];
        });
        return lines.length ? [{ name: 'propose_distru_purchases_upsert', args: { vendor_id: vendorId, location_id: locationId, lines, notes: 'Restock' } }] : [];
      });
      const guard = behaviour.skipCaps ? [] : GuardLine.parse(jsonAfter(prompt, 'exact cap):') ?? []);
      const caps = guard.map((g) => ({ name: 'propose_distru_mcp_mutate_product', args: { action: 'UPDATE', id: g.product_id, maxMenuBuyerOrderQuantity: behaviour.capOverride ?? g.cap } }));
      return calls.length ? { tools: [...calls, ...caps] } : final([]);
    }
    return final(items.map((i) => ({ product_id: i.product_id, sku: i.sku, location_id: i.location_id ?? '?', decision: (i.suggested_qty ?? 0) > 0 ? 'ordered' : 'skipped', quantity: i.suggested_qty ?? 0, unit_price: null, reason: (i.suggested_qty ?? 0) > 0 ? 'suggested quantity' : 'covered: watch only' })));
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
  crossTool?: CrossToolOptions;
  /** Boot without the Distru MCP bridge reachable (degraded mode); `connectMcp()` later brings it up. */
  mcpDown?: boolean;
  /** Register the Composio connector (vendor-reply tests: the in-process emulator world). */
  composio?: () => Promise<ComposioBridge<'composio'>>;
  /** Slack approvals / notifications for both workflows. */
  notifier?: ProposalNotifier;
}

export async function restockEnv(options: RestockEnvOptions = {}) {
  const mock = createMockServer({ now: NOW });
  const headset = createHeadsetMock({ now: NOW });
  const net = { purchaseWrites: 0, taskWrites: 0 };
  const fetch: FetchLike = async (url, init) => {
    const res = await mock.app.request(url, init);
    const isPost = (init?.method ?? 'GET').toUpperCase() === 'POST' && res.ok;
    const path = new URL(url).pathname;
    if (isPost && path === PURCHASES_PATH) net.purchaseWrites++;
    if (isPost && path === TASKS_PATH) net.taskWrites++;
    return res;
  };
  // The Distru mock's MCP endpoint, in-process (Streamable HTTP over app.request).
  const mcpState = { down: options.mcpDown ?? false };
  const mcpFetch = async (url: string | URL, init?: RequestInit) => {
    if (mcpState.down) throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:4500');
    return mock.app.request(url instanceof URL ? url.toString() : url, init);
  };
  const connectors = new AppConnectors({
    connectMcp: () => createDistruMcpConnector({ url: 'http://mock.test/mcp', key: MCP_KEY, fetch: mcpFetch }),
    mcpUrl: 'http://mock.test/mcp',
    ...(options.composio ? { connectComposio: options.composio } : {}),
  });
  await connectors.start();
  const outbox = new OutboxTransport({ now: () => new Date(NOW) });
  const contexts = buildAppContexts({
    baseUrl: 'http://mock.test',
    token: 'mock-token',
    fetch,
    headset: { baseUrl: 'http://headset.test', token: 'headset-mock-token', fetch: async (url, init) => headset.app.request(url, init) },
    email: { transport: outbox, from: 'Golden Coast Purchasing <purchasing@goldencoastdistro.com>' },
    mcpClient: () => connectors.mcpClient(),
    composioClient: () => connectors.composioClient(),
  });
  const store = new InMemoryProposalStore();
  const audit = new InMemoryAuditSink();
  const rules = new StaticPolicyRules(options.rules ?? DEFAULT_RULES);
  const harness = createHarness({ registry: () => connectors.registry, store, audit, policyRules: rules, errors: appErrorClassifier, policyEngine: appPolicyEngine, random: () => 0.5 });
  const findProposalByRunId = async (runId: string) => (await store.list()).find((p) => p.meta.workflowRunId === runId) ?? null;

  const deps: RestockDeps = {
    get registry() {
      return connectors.registry;
    },
    harness,
    policyRules: rules,
    contexts: () => contexts,
    pricing: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
    findProposalByRunId,
    crossTool: options.crossTool ?? {},
    now: () => new Date(NOW),
    ...(options.notifier ? { notifier: options.notifier } : {}),
  };
  const vendorReplyDeps: VendorReplyDeps = {
    get registry() {
      return connectors.registry;
    },
    harness,
    contexts: () => contexts,
    pricing: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
    findProposalByRunId,
    now: () => new Date(NOW),
    ...(options.notifier ? { notifier: options.notifier } : {}),
  };

  const scripts: Record<AgentKey, Script> = {
    opsLead: opsLeadScript,
    inventoryAnalyst: analystScript,
    procurementPlanner: plannerScript(options.planner ?? {}),
    complianceReviewer: reviewerScript,
    policyCritic: criticScript,
    vendorLiaison: vendorLiaisonScript,
  };
  const models = Object.fromEntries(Object.entries(scripts).map(([k, s]) => [k, scriptedModel(k, s)])) as Record<AgentKey, ReturnType<typeof scriptedModel>>;

  const launcher = new RestockLauncher();
  const agents = createAgents({
    get registry() {
      return connectors.registry;
    },
    harness,
    readCtx: () => contexts.read,
    models,
    launcher,
  });
  const mastra = new Mastra({
    agents,
    workflows: { [RESTOCK_WORKFLOW_KEY]: createRestockWorkflowInProcess(deps), [VENDOR_REPLY_WORKFLOW_KEY]: createVendorReplyWorkflowInProcess(vendorReplyDeps) },
    storage: new InMemoryStore(),
    logger: false,
  });
  launcher.bind(mastra);

  const approver = { kind: 'user' as const, id: 'u-approver', scopes: ['read' as const, 'propose' as const, 'approve' as const], label: 'Ana Approver' };
  const planner = agentPrincipal('procurement-planner');

  /** Product ids by SKU (via the connector, as an agent would see them). */
  const productId = async (sku: string) => {
    const p = z.object({ id: z.string() }).parse(await connectors.registry.runReadTool(contexts.read, planner, 'distru.products_get', { sku }));
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

  /** Mock control plane (POST /__mock/config), e.g. `{ mcp_rate_limit: { fail_next: 50, retry_after: 0 } }`. */
  const configureMock = async (body: unknown) => {
    const res = await mock.app.request('/__mock/config', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    if (!res.ok) throw new Error(`mock config failed: ${res.status} ${await res.text()}`);
  };
  /** Bring the MCP server "back up" and let the app reconnect (the periodic refresh, run once). */
  const connectMcp = async () => {
    mcpState.down = false;
    return connectors.refresh();
  };

  /** Polls a vendor-reply run (same as `waitFor`, on the vendor-reply workflow). */
  const waitForVendorReply = async (runId: string, statuses: string[], timeoutMs = 20_000) => {
    const started = Date.now();
    for (;;) {
      const state = await launcher.decisionWorkflow('vendor-reply').getWorkflowRunById(runId);
      if (state && statuses.includes(state.status)) return state;
      if (state?.status === 'failed' && !statuses.includes('failed')) throw new Error(`vendor-reply run failed: ${state.error?.message ?? JSON.stringify(state.steps)}`);
      if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${statuses.join('|')} (last: ${state?.status})`);
      await Bun.sleep(25);
    }
  };

  return { mock, headset, net, outbox, connectors, contexts, store, audit, rules, harness, deps, vendorReplyDeps, agents, mastra, launcher, approver, productId, locations, waitFor, waitForVendorReply, findProposalByRunId, configureMock, connectMcp, mcpState };
}

export type RestockEnv = Awaited<ReturnType<typeof restockEnv>>;
