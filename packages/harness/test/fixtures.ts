import { z } from 'zod';
import {
  agentPrincipal,
  createHarness,
  defineAction,
  defineReadTool,
  FakeClock,
  InMemoryAuditSink,
  InMemoryProposalStore,
  matchesExpected,
  Registry,
  sequentialIds,
  StaticPolicyRules,
  userPrincipal,
  type ErrorClassifier,
  type HarnessConfig,
  type PolicyRuleConfig,
  type Proposal,
  type Risk,
  type StepRunner,
} from '../src';

// --- A tiny fake ERP with Distru-like sparse upsert semantics -------------------------------

export interface LineItem {
  id: string;
  productId: string;
  quantity: number;
  unitPrice: number;
}
export interface Purchase {
  id: string;
  vendorId: string;
  status: string;
  externalRef: string | null;
  items: LineItem[];
}

export class HttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;
  constructor(status: number, retryAfterMs?: number) {
    super(`HTTP ${status}`);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export const httpClassifier: ErrorClassifier = {
  isRetryable: (err) => err instanceof HttpError && (err.status === 429 || err.status >= 500),
  retryAfterMs: (err) => (err instanceof HttpError ? err.retryAfterMs : undefined),
};

export class FakeErp {
  readonly purchases = new Map<string, Purchase>();
  writes = 0;
  /** Errors thrown (in order) by upcoming writes, before anything is applied. */
  failures: Error[] = [];
  /** Applied to the stored record after a write (simulates the ERP silently altering data). */
  corrupt: ((p: Purchase) => void) | null = null;
  #nextId = 100;

  seed(p: Purchase): void {
    this.purchases.set(p.id, structuredClone(p));
  }

  get(id: string): Purchase | null {
    const p = this.purchases.get(id);
    return p ? structuredClone(p) : null;
  }

  findByRef(ref: string): Purchase | null {
    for (const p of this.purchases.values()) if (p.externalRef === ref) return structuredClone(p);
    return null;
  }

  upsert(payload: PurchasePayload, externalRef: string): Purchase {
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.writes++;
    const existing = payload.id ? this.purchases.get(payload.id) : undefined;
    const prevItems = new Map((existing?.items ?? []).map((i) => [i.id, i]));
    const items = payload.items
      ? payload.items.map((i) => ({ ...(i.id ? prevItems.get(i.id) : undefined), ...i, id: i.id ?? `li-${this.#nextId++}` }))
      : (existing?.items ?? []);
    const next: Purchase = {
      id: existing?.id ?? `po-${this.#nextId++}`,
      vendorId: payload.vendorId ?? existing?.vendorId ?? '',
      status: payload.status ?? existing?.status ?? 'draft',
      externalRef,
      items: items.map((i) => ({ id: i.id, productId: i.productId, quantity: i.quantity, unitPrice: i.unitPrice })),
    };
    this.corrupt?.(next);
    this.purchases.set(next.id, next);
    return structuredClone(next);
  }
}

export interface Ctx {
  erp: FakeErp;
}

// --- Example action: purchases.upsert ------------------------------------------------------

const ItemInput = z.object({
  id: z.string().optional(),
  productId: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: z.number().nonnegative(),
});

export const PurchaseUpsertInput = z.object({
  purchaseId: z.string().optional(),
  vendorId: z.string(),
  status: z.string().optional(),
  items: z.array(ItemInput).min(1),
});

export const PurchasePayloadSchema = z.object({
  id: z.string().optional(),
  vendorId: z.string().optional(),
  status: z.string().optional(),
  items: z.array(ItemInput).optional(),
});
export type PurchasePayload = z.infer<typeof PurchasePayloadSchema>;

export function purchaseUpsertAction(risk: Risk = 'low') {
  return defineAction({
    name: 'purchases.upsert',
    resource: 'purchases',
    description: 'Create or update a purchase order (sparse upsert).',
    risk,
    input: PurchaseUpsertInput,
    payload: PurchasePayloadSchema,
    loadBefore: async (ctx: Ctx, input) => (input.purchaseId ? ctx.erp.get(input.purchaseId) : null),
    plan: (_ctx: Ctx, input): PurchasePayload => ({
      ...(input.purchaseId ? { id: input.purchaseId } : {}),
      vendorId: input.vendorId,
      ...(input.status ? { status: input.status } : {}),
      items: input.items,
    }),
    execute: async (ctx: Ctx, payload, key) => {
      const record = ctx.erp.upsert(payload, key);
      return { recordId: record.id, record };
    },
    verify: async (ctx: Ctx, recordId, expected) => {
      const { id: _id, ...rest } = expected;
      return matchesExpected(ctx.erp.get(recordId), rest);
    },
    findByIdempotencyKey: async (ctx: Ctx, key) => {
      const record = ctx.erp.findByRef(key);
      return record ? { recordId: record.id, record } : null;
    },
    valueOf: (payload) => (payload.items ?? []).reduce((sum, i) => sum + i.quantity * i.unitPrice, 0),
    vendorIdsOf: (payload) => (payload.vendorId ? [payload.vendorId] : []),
    summarize: (input) => `PO for ${input.items.length} line(s) from ${input.vendorId}`,
  });
}

export const inventoryReadTool = defineReadTool({
  name: 'inventory.search',
  description: 'Search inventory.',
  input: z.object({ query: z.string().min(1) }),
  output: z.array(z.object({ sku: z.string(), quantity: z.number() })),
  run: async (_ctx: Ctx, input) => [{ sku: input.query.toUpperCase(), quantity: 3 }],
});

// --- Principals ------------------------------------------------------------------------------

export const agent = agentPrincipal('restock-agent', 'Procurement Planner');
export const operator = userPrincipal('u-operator', 'operator');
export const approver = userPrincipal('u-approver', 'approver');
export const approver2 = userPrincipal('u-approver-2', 'approver');

// --- Harness setup ---------------------------------------------------------------------------

export interface SetupOptions {
  risk?: Risk;
  rules?: PolicyRuleConfig[];
  steps?: StepRunner;
  store?: InMemoryProposalStore;
  config?: Partial<HarnessConfig<Ctx>>;
}

export function setup(options: SetupOptions = {}) {
  const erp = new FakeErp();
  const store = options.store ?? new InMemoryProposalStore();
  const audit = new InMemoryAuditSink();
  const clock = new FakeClock();
  const rules = new StaticPolicyRules(options.rules ?? []);
  const registry = new Registry<Ctx>({ actions: [purchaseUpsertAction(options.risk)], readTools: [inventoryReadTool] });
  const harness = createHarness<Ctx>({
    registry,
    store,
    audit,
    clock,
    policyRules: rules,
    ids: sequentialIds('p'),
    errors: httpClassifier,
    random: () => 0.5,
    ...(options.steps ? { steps: options.steps } : {}),
    ...options.config,
  });
  const ctx: Ctx = { erp };
  return { harness, erp, store, audit, clock, rules, registry, ctx };
}

export const poInput = (overrides: Partial<z.input<typeof PurchaseUpsertInput>> = {}) => ({
  vendorId: 'v-acme',
  items: [{ productId: 'sku-1', quantity: 10, unitPrice: 5 }],
  ...overrides,
});

/** Propose (as the agent) and approve (as the approver) a single PO. */
export async function approvedProposal(env: ReturnType<typeof setup>, ops = [poInput()]): Promise<Proposal> {
  const proposal = await env.harness.propose({
    ctx: env.ctx,
    principal: agent,
    ops: ops.map((input) => ({ action: 'purchases.upsert', input })),
  });
  return env.harness.decide({ ctx: env.ctx, principal: approver, proposalId: proposal.id, decision: 'approve' });
}
