/**
 * The world a scenario runs in, in-process with no live servers: the Distru mock (REST and its MCP
 * endpoint via `app.request`), the Headset mock, the mock email outbox, the real connectors and app
 * registry, an in-memory harness with the app's policy engine, the five real agents (real
 * instructions and tools; models from the caller), and the restock workflow on Mastra's default
 * engine with in-memory storage. Mirrors `apps/agent/test/fixtures/restock-env.ts`, which hardcodes
 * scripted models; here the models are real (live) or replayed (offline).
 *
 * Imports apps/agent sources read-only (relative paths); nothing in apps/* is modified.
 */
import { Mastra } from '@mastra/core';
import type { MastraModelConfig } from '@mastra/core/llm';
import { InMemoryStore } from '@mastra/core/storage';
import { OutboxTransport } from '@ops/connector-email';
import { createDistruMcpConnector } from '@ops/connector-mcp';
import type { FetchLike } from '@ops/distru-client';
import { createMockServer } from '@ops/distru-mock';
import { createHeadsetMock } from '@ops/headset-mock';
import { agentPrincipal, createHarness, InMemoryAuditSink, InMemoryProposalStore, StaticPolicyRules, type PolicyRuleConfig } from '@ops/harness';
import { z } from 'zod';
import { appPolicyEngine, DEFAULT_ALLOWED_ACTIONS, DEFAULT_EMAIL_DOMAINS } from '../../../apps/agent/src/harness/policy';
import { AppConnectors, appErrorClassifier, buildAppContexts } from '../../../apps/agent/src/harness/registry';
import { createAgents } from '../../../apps/agent/src/mastra/agents';
import type { AgentKey } from '../../../apps/agent/src/mastra/agents/roster';
import { RestockLauncher, RESTOCK_WORKFLOW_KEY } from '../../../apps/agent/src/mastra/restock-launcher';
import { createRestockWorkflowInProcess, type RestockDeps } from '../../../apps/agent/src/mastra/workflows/restock';
import type { Pricing } from './llm';
import type { Scenario } from './scenario';

/** The Distru mock's "today" (seeded data is anchored to it; recordings depend on it). */
export const NOW = '2026-11-19T12:00:00Z';

/** Same rules as the seed (apps/agent/src/db/seed.ts). */
export const DEFAULT_RULES: PolicyRuleConfig[] = [
  { key: 'max_total_value', params: { max: 25_000 } },
  { key: 'auto_approve_below', params: { amount: 500, max_risk: 'medium' } },
  { key: 'high_risk_requires_approval', params: {} },
  { key: 'allowed_actions', params: { actions: DEFAULT_ALLOWED_ACTIONS } },
  { key: 'email_recipient_domains', params: { domains: DEFAULT_EMAIL_DOMAINS, onViolation: 'deny' } },
];

const PURCHASES_PATH = '/public/v1/purchases';
const TASKS_PATH = '/public/v1/tasks';
const MCP_KEY = 'distru_mcp_mock';

export function rulesFor(scenario: Scenario): PolicyRuleConfig[] {
  const overrides = scenario.emulatorSetup.policyRules;
  const merged = DEFAULT_RULES.map((r) => {
    const o = overrides.find((x) => x.key === r.key);
    return o ? { key: r.key, params: o.params, ...(o.enabled === undefined ? {} : { enabled: o.enabled }) } : r;
  });
  for (const o of overrides) if (!DEFAULT_RULES.some((r) => r.key === o.key)) merged.push({ key: o.key, params: o.params, ...(o.enabled === undefined ? {} : { enabled: o.enabled }) });
  return merged;
}

export interface WorldOptions {
  scenario: Scenario;
  models: Record<AgentKey, MastraModelConfig>;
  pricing: Pricing;
}

export async function createWorld({ scenario, models, pricing }: WorldOptions) {
  const mock = createMockServer({ now: NOW, scenario: scenario.mockScenario });
  const headset = createHeadsetMock({ now: NOW, scenario: scenario.headsetScenario ?? scenario.mockScenario });
  const net = { purchaseWrites: 0, taskWrites: 0 };
  const fetch: FetchLike = async (url, init) => {
    const res = await mock.app.request(url, init);
    const isPost = (init?.method ?? 'GET').toUpperCase() === 'POST' && res.ok;
    const path = new URL(url).pathname;
    if (isPost && path === PURCHASES_PATH) net.purchaseWrites++;
    if (isPost && path === TASKS_PATH) net.taskWrites++;
    return res;
  };
  const mcpFetch = async (url: string | URL, init?: RequestInit) => mock.app.request(url instanceof URL ? url.toString() : url, init);
  const connectors = new AppConnectors({
    connectMcp: () => createDistruMcpConnector({ url: 'http://mock.test/mcp', key: MCP_KEY, fetch: mcpFetch }),
    mcpUrl: 'http://mock.test/mcp',
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
  });
  const store = new InMemoryProposalStore();
  const audit = new InMemoryAuditSink();
  const rules = new StaticPolicyRules(rulesFor(scenario));
  // Retries without real waiting (Retry-After 0 in the mock config keeps 429 storms fast).
  const harness = createHarness({ registry: () => connectors.registry, store, audit, policyRules: rules, errors: appErrorClassifier, policyEngine: appPolicyEngine, random: () => 0.5 });
  const findProposalByRunId = async (runId: string) => (await store.list()).find((p) => p.meta.workflowRunId === runId) ?? null;

  const deps: RestockDeps = {
    get registry() {
      return connectors.registry;
    },
    harness,
    policyRules: rules,
    contexts: () => contexts,
    pricing,
    findProposalByRunId,
    crossTool: {},
    now: () => new Date(NOW),
  };

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
    workflows: { [RESTOCK_WORKFLOW_KEY]: createRestockWorkflowInProcess(deps) },
    storage: new InMemoryStore(),
    logger: false,
  });
  launcher.bind(mastra);

  const approver = { kind: 'user' as const, id: 'u-evals-approver', scopes: ['read' as const, 'propose' as const, 'approve' as const], label: 'Eval Approver' };
  const planner = agentPrincipal('procurement-planner');

  const productId = async (sku: string) => {
    const p = z.object({ id: z.string() }).parse(await connectors.registry.runReadTool(contexts.read, planner, 'distru.products_get', { sku }));
    return p.id;
  };
  const skuById = async (): Promise<Map<string, string>> => {
    const distru = contexts.read.connectors.distru;
    const all = await distru.listAll(distru.listProducts, {});
    return new Map(all.flatMap((p) => (p.id && p.sku ? [[p.id, p.sku] as const] : [])));
  };
  const locations = async () => {
    const distru = contexts.read.connectors.distru;
    const all = await distru.listAll(distru.listLocations, {});
    return all.map((l) => ({ id: l.id, name: l.name ?? l.id }));
  };

  const waitFor = async (runId: string, statuses: string[], timeoutMs = 15 * 60_000) => {
    const started = Date.now();
    for (;;) {
      const state = await launcher.workflow().getWorkflowRunById(runId);
      if (state && statuses.includes(state.status)) return state;
      if (state?.status === 'failed') return state;
      if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${statuses.join('|')} (last: ${state?.status})`);
      await Bun.sleep(25);
    }
  };

  const configureMock = async (body: unknown) => {
    const res = await mock.app.request('/__mock/config', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    if (!res.ok) throw new Error(`mock config failed: ${res.status} ${await res.text()}`);
  };

  return { mock, headset, net, outbox, connectors, contexts, store, audit, rules, harness, deps, agents, mastra, launcher, approver, productId, skuById, locations, waitFor, findProposalByRunId, configureMock };
}

export type World = Awaited<ReturnType<typeof createWorld>>;
