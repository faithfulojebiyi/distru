/** The mock Distru API in-process (no network) + the full harness with in-memory adapters. */
import { DistruApiError, type FetchLike } from '@ops/distru-client';
import { createMockServer } from '@ops/distru-mock';
import {
  agentPrincipal,
  createHarness,
  FakeClock,
  InMemoryAuditSink,
  InMemoryProposalStore,
  Registry,
  sequentialIds,
  StaticPolicyRules,
  userPrincipal,
  type PolicyRuleConfig,
  type StepRunner,
} from '@ops/harness';
import { createDistruContext, distruConnector, distruErrorClassifier } from '../src';

export const NOW = '2026-11-19T12:00:00Z';
export const AUTO_APPROVE_BELOW = 500;
export const DEFAULT_RULES: PolicyRuleConfig[] = [
  { key: 'auto_approve_below', params: { maxValue: AUTO_APPROVE_BELOW } },
  { key: 'max_total_value', params: { max: 25_000 } },
];

export const planner = agentPrincipal('procurement-planner', 'Procurement Planner');
export const approver = userPrincipal('u-approver', 'approver', 'Ana Approver');

const PURCHASES_PATH = '/public/v1/purchases';

export interface SetupOptions {
  rules?: PolicyRuleConfig[];
  steps?: StepRunner;
}

export function setup(options: SetupOptions = {}) {
  const mock = createMockServer({ now: NOW });
  const net = {
    /** Successful POST /purchases (writes that landed in the mock). */
    purchaseWrites: 0,
    /** Next successful purchase write lands, then the client sees this error instead of the response. */
    crashAfterWrite: null as Error | null,
  };
  const fetch: FetchLike = async (url, init) => {
    const res = await mock.app.request(url, init);
    const isWrite = (init?.method ?? 'GET').toUpperCase() === 'POST' && new URL(url).pathname === PURCHASES_PATH;
    if (isWrite && res.ok) {
      net.purchaseWrites++;
      const crash = net.crashAfterWrite;
      if (crash) {
        net.crashAfterWrite = null;
        throw crash;
      }
    }
    return res;
  };
  // maxRetries 0: 429s surface to the harness, which owns retry/backoff (and audits it).
  const ctx = createDistruContext({ baseUrl: 'http://mock.test', token: 'mock-token', fetch, maxRetries: 0 });
  const registry = Registry.fromConnectors([distruConnector]);
  const store = new InMemoryProposalStore();
  const audit = new InMemoryAuditSink();
  const clock = new FakeClock(NOW);
  const rules = new StaticPolicyRules(options.rules ?? DEFAULT_RULES);
  const harness = createHarness({
    registry,
    store,
    audit,
    clock,
    policyRules: rules,
    ids: sequentialIds('p'),
    errors: distruErrorClassifier,
    random: () => 0.5,
    ...(options.steps ? { steps: options.steps } : {}),
  });

  const read = (tool: string, input: unknown = {}) => registry.runReadTool(ctx, planner, `distru.${tool}`, input);
  const configureMock = async (body: unknown) => {
    const res = await mock.app.request('/__mock/config', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    if (!res.ok) throw new Error(`mock config failed: ${res.status}`);
    return res.json();
  };
  const mockState = async () => (await mock.app.request('/__mock/state')).json() as Promise<MockState>;
  const crashAfterWrite = (err: Error) => {
    net.crashAfterWrite = err;
  };
  return { mock, net, ctx, registry, store, audit, clock, rules, harness, read, configureMock, mockState, crashAfterWrite };
}

export interface MockState {
  seed: { below_reorder_skus: string[]; failed_lab_test: { sku: string } | null; prompt_injection: { product_id: string; sku: string } | null };
  locations: Array<{ id: string; name: string }>;
  vendors: Array<{ id: string; name: string; typical_lead_time_days: number }>;
  counts: { purchases: number };
}

/** A 503 thrown after the write landed (e.g. a gateway timeout): retryable. */
export const gatewayTimeout = () => new DistruApiError(503, [{ message: 'upstream timeout', pointer: ['base'] }], 'POST', 'http://mock.test/public/v1/purchases');

export type Env = ReturnType<typeof setup>;
