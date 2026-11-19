import { createStep, createWorkflow as createDefaultWorkflow } from '@mastra/core/workflows';
import { PurchaseUpsertInputSchema, type PurchaseUpsertInput } from '@ops/connector-distru';
import {
  PolicyEvaluationSchema,
  ProposalStatusSchema,
  totalValue,
  type Harness,
  type PolicyEvaluation,
  type PolicyReason,
  type PolicyRuleSource,
  type Proposal,
  type Registry,
} from '@ops/harness';
import { z } from 'zod';
import { dryRunPolicy, previewOp } from '../../harness/dry-run';
import type { AppCtx } from '../../harness/registry';
import { complianceReviewPrompt, ComplianceReviewSchema } from '../agents/compliance-reviewer';
import { AtRiskSkuSchema, inventoryAnalystPrompt, InventoryAnalysisSchema, type AtRiskSku } from '../agents/inventory-analyst';
import { PolicyCritiqueSchema, policyCriticPrompt } from '../agents/policy-critic';
import { GuardSuggestionSchema, PlannerResultSchema, plannerPrompt, plannerRevisionPrompt } from '../agents/procurement-planner';
import { AGENTS, principalFor } from '../agents/roster';
import { SuspiciousTextFlagSchema, type SuspiciousTextFlag } from '../agents/shared';
import type { ProposalNotifier } from '../../slack/approvals';
import { inngestWorkflowKit } from '../inngest';
import { AWAIT_DECISION_STEP, RESTOCK_WORKFLOW_ID, RestockResumeSchema, RestockTriggerSchema, type RestockTrigger } from '../restock-launcher';
import { draftOpFrom, DraftOpSchema, DraftProposal, type DraftOp } from '../tools/run-context';
import { AgentTraceEntrySchema, sumTrace, type AgentTraceEntry, type Pricing } from '../trace';
import { callAgent } from './agent-call';
import { chooseHeadline, restockTemplateTitle, untrustedTextsIn, type HeadlineFacts } from '../../harness/titles';
import { contextBlock } from './context-block';
import { DemandCandidateSchema, mergeWithScan, scanDemand } from './demand';
import {
  assembleProposal,
  CAP_ACTION,
  capFindings,
  computeGuard,
  EMAIL_ACTION,
  opBelongsTo,
  pruneCaps,
  PURCHASE_ACTION,
  TASK_ACTION,
  type CrossToolOptions,
} from './cross-tool';

/**
 * Restock workflow ("Restock at-risk SKUs"), durable on Inngest (`@mastra/inngest`):
 *
 *   prepare ─▶ foreach(location) Inventory Analyst ─▶ merge + group by vendor
 *     ─▶ foreach(vendor) Procurement Planner (propose_* → the run's draft)
 *     ─▶ dountil(review round: Compliance Reviewer vetoes → plan guard → policy dry-run
 *                ─▶ deny? Policy Critic → Planner revises; max 2 revisions)
 *     ─▶ propose (ONE harness proposal, meta.workflowRunId; per PO: PO → buyer cap(s) → vendor email →
 *                 receiving task, the last two referencing the PO via {{op:N.…}}) ─▶ await-decision
 *     ─▶ execute (harness.execute: idempotent, one write per op, verify-after-write) ─▶ finalize
 *
 * LLMs propose; deterministic code decides and executes. Every agent result is a zod-validated
 * structured output, every Mastra step is memoized by Inngest, and re-running any step is safe:
 * `propose` looks up an existing proposal for the run, `execute` relies on the harness's
 * idempotency keys. The same steps run on Mastra's default engine in tests.
 */

export const MAX_REVISIONS = 2;
/** plan_guard: a line above this multiple of the analysed suggestion is denied (prompt-injection / runaway backstop). */
export const QUANTITY_GUARD_MULTIPLIER = 3;

export interface RestockDeps {
  registry: Registry<AppCtx>;
  harness: Harness<AppCtx>;
  /** The rule source the harness evaluates (for the policy dry-run). */
  policyRules: PolicyRuleSource;
  contexts: () => { read: AppCtx; execute: AppCtx };
  pricing: Pricing;
  /** Makes `propose` idempotent across step retries: an existing proposal for the run is reused. */
  findProposalByRunId?: (runId: string) => Promise<Proposal | null>;
  /** Vendor emails, receiving tasks and the allocation guard (all on by default when their connector is registered). */
  crossTool?: CrossToolOptions;
  /** Clock for active-buyer windows and receiving dates (tests pin it to the mock's "now"). */
  now?: () => Date;
  /** Slack approval request + run notifications (best-effort; never fails a step). */
  notifier?: ProposalNotifier;
}

// ── schemas ─────────────────────────────────────────────────────────────────────────────────────

const LocationRefSchema = z.object({ id: z.string(), name: z.string() });
const VendorRefSchema = z.object({ id: z.string(), name: z.string(), lead_time_days: z.number().nullable(), purchase_order_email: z.string().nullable().default(null) });
const TraceList = z.array(AgentTraceEntrySchema);

const AnalyseTaskSchema = z.object({
  trigger: RestockTriggerSchema,
  location: LocationRefSchema,
  vendors: z.array(VendorRefSchema),
  /** The deterministic demand scan's candidates for this location (wholesale and/or retail flagged, in code). */
  candidates: z.array(DemandCandidateSchema).default([]),
});
const AnalyseResultSchema = z.object({ location: LocationRefSchema, analysis: InventoryAnalysisSchema, agentTrace: TraceList });
const VendorTaskSchema = z.object({
  trigger: RestockTriggerSchema,
  vendor: VendorRefSchema,
  items: z.array(AtRiskSkuSchema),
  /** Allocation-guard caps computed in code for this vendor's SKUs. */
  guard: z.array(GuardSuggestionSchema).default([]),
  guardNote: z.string().nullable().default(null),
});
type VendorTask = z.infer<typeof VendorTaskSchema>;
const PlanResultSchema = z.object({ vendor: VendorRefSchema, ops: z.array(DraftOpSchema), result: PlannerResultSchema, agentTrace: TraceList });

export const VetoedLineSchema = z
  .object({
    product_id: z.string(),
    sku: z.string().nullable(),
    vendor_id: z.string().nullable(),
    location_id: z.string().nullable(),
    quantity: z.number().nullable(),
    reasons: z.array(z.string()),
    source: z.enum(['compliance-reviewer', 'compliance_check', 'both']),
  })
  .meta({ id: 'VetoedLine' });
export type VetoedLine = z.infer<typeof VetoedLineSchema>;

const CritiqueRecordSchema = z.object({ round: z.number().int(), explanation: z.string(), revisions: z.array(z.object({ vendor_id: z.string(), instruction: z.string() })) });

const ReviewStateSchema = z.object({
  trigger: RestockTriggerSchema,
  round: z.number().int(),
  revisions: z.number().int(),
  ops: z.array(DraftOpSchema),
  vendors: z.array(VendorTaskSchema),
  atRisk: z.array(AtRiskSkuSchema),
  vetoed: z.array(VetoedLineSchema),
  suspicious: z.array(SuspiciousTextFlagSchema),
  policy: PolicyEvaluationSchema.nullable(),
  critiques: z.array(CritiqueRecordSchema),
  analysisSummaries: z.array(z.string()),
  plannerSummaries: z.array(z.object({ vendor: z.string(), summary: z.string() })),
  /** The latest Planner headline per vendor (validated in code before use as the proposal title). */
  plannerHeadlines: z.array(z.object({ vendor_id: z.string(), title: z.string().nullable(), summary: z.string() })).default([]),
  complianceSummary: z.string().nullable(),
  done: z.boolean(),
  outcome: z.enum(['pending', 'ready', 'empty', 'exhausted']),
  agentTrace: TraceList,
});
type ReviewState = z.infer<typeof ReviewStateSchema>;

const ProposeResultSchema = z.object({
  proposalId: z.string().nullable(),
  proposalStatus: ProposalStatusSchema.nullable(),
  outcome: z.enum(['ready', 'empty', 'exhausted']),
  totalValue: z.number().nullable(),
  agentTrace: TraceList,
});

const DecisionResultSchema = z.object({
  proposalId: z.string().nullable(),
  decision: z.enum(['approved', 'rejected', 'denied', 'none']),
  proposalStatus: ProposalStatusSchema.nullable(),
});

const ExecuteResultSchema = DecisionResultSchema.extend({ executed: z.boolean() });

export const RestockResultSchema = z
  .object({
    status: z.enum(['executed', 'failed', 'rejected', 'denied', 'nothing_to_order']),
    proposalId: z.string().nullable(),
    proposalStatus: ProposalStatusSchema.nullable(),
    purchaseOrderIds: z.array(z.string()),
    /** Outbox / provider message ids of the vendor emails sent. */
    emailIds: z.array(z.string()).default([]),
    /** Distru task ids of the receiving hand-off tasks. */
    taskIds: z.array(z.string()).default([]),
    /** Products whose per-buyer menu cap was set (allocation guard). */
    buyerCapProductIds: z.array(z.string()).default([]),
    verified: z.boolean(),
    totalValue: z.number().nullable(),
    message: z.string(),
  })
  .meta({ id: 'RestockResult' });
export type RestockResult = z.infer<typeof RestockResultSchema>;

const SuspendSchema = z.object({ proposalId: z.string(), status: z.string(), title: z.string().nullable() });

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────

const plannerPrincipal = principalFor('procurementPlanner');
const reviewerPrincipal = principalFor('complianceReviewer');
const analystPrincipal = principalFor('inventoryAnalyst');

const money = (n: number | null) => (n === null ? 'unknown' : `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
const uniq = <T>(xs: Iterable<T>) => [...new Set(xs)];

function purchaseInput(op: DraftOp): PurchaseUpsertInput | null {
  if (op.action !== PURCHASE_ACTION) return null;
  const parsed = PurchaseUpsertInputSchema.safeParse(op.input);
  return parsed.success ? parsed.data : null;
}

function opVendorId(op: DraftOp): string | null {
  return purchaseInput(op)?.vendor_id ?? op.vendorIds?.[0] ?? null;
}

interface DraftLine {
  key: string;
  product_id: string;
  vendor_id: string;
  location_id: string;
  quantity: number;
}

function linesOf(ops: readonly DraftOp[]): DraftLine[] {
  return ops.flatMap((op) => {
    const input = purchaseInput(op);
    return input ? input.lines.map((l) => ({ key: op.key, product_id: l.product_id, vendor_id: input.vendor_id, location_id: input.location_id, quantity: l.quantity })) : [];
  });
}

function mergeFlags(...lists: SuspiciousTextFlag[][]): SuspiciousTextFlag[] {
  const seen = new Map<string, SuspiciousTextFlag>();
  for (const f of lists.flat()) seen.set(`${f.product_id ?? f.sku ?? ''}|${f.source}`, f);
  return [...seen.values()];
}

const ComplianceStatusSchema = z.object({
  products: z.array(z.object({ product_id: z.string(), sku: z.string().nullable(), status: z.enum(['ok', 'blocked', 'unknown']), reasons: z.array(z.string()) })),
});

const VendorsSchema = z.object({ vendors: z.array(z.object({ id: z.string(), name: z.string(), lead_time_days: z.number().nullable(), purchase_order_email: z.string().nullable() })) });

function guardFindings(ops: readonly DraftOp[], atRisk: readonly AtRiskSku[], vendors: readonly VendorTask[] = []): PolicyReason[] {
  const reasons: PolicyReason[] = capFindings(ops, vendors.flatMap((v) => v.guard)).map((message) => ({ rule: 'plan_guard', outcome: 'deny' as const, severity: 'error' as const, message }));
  for (const line of linesOf(ops)) {
    const sku = atRisk.find((r) => r.product_id === line.product_id && (r.location_id === null || r.location_id === line.location_id));
    if (!sku) {
      reasons.push({ rule: 'plan_guard', outcome: 'deny', severity: 'error', message: `Product ${line.product_id} was not flagged as at risk by the analysis; remove it` });
      continue;
    }
    // Retail-adjusted demand (when larger) raises the basis: a surging SKU may need more than wholesale history says.
    const daily = Math.max(sku.avg_daily_demand, sku.adjusted_avg_daily_demand ?? 0);
    const basis = Math.max(sku.suggested_qty ?? 0, sku.units_per_case ?? 0, Math.ceil(daily * 30));
    const limit = basis * QUANTITY_GUARD_MULTIPLIER;
    if (limit > 0 && line.quantity > limit) {
      reasons.push({
        rule: 'plan_guard',
        outcome: 'deny',
        severity: 'error',
        message: `${sku.sku}: ${line.quantity} units is more than ${QUANTITY_GUARD_MULTIPLIER}× the analysed basis (${basis}); use the suggested quantity (${sku.suggested_qty ?? 'n/a'})`,
      });
    }
  }
  return reasons;
}

function withGuard(evaluation: PolicyEvaluation, guard: PolicyReason[]): PolicyEvaluation {
  if (!guard.length) return { ...evaluation, reasons: [...evaluation.reasons, { rule: 'plan_guard', outcome: 'pass', severity: 'info', message: 'Quantities within the analysed bounds; buyer caps match the computed guard' }] };
  return { outcome: 'deny', reasons: [...evaluation.reasons, ...guard] };
}

/** Drop vetoed products from each purchase op; ops left without lines disappear. Re-plans changed ops. */
async function dropVetoed(deps: RestockDeps, ops: readonly DraftOp[], vetoed: ReadonlySet<string>): Promise<DraftOp[]> {
  if (!vetoed.size) return pruneCaps(ops);
  const ctx = deps.contexts().read;
  const out: DraftOp[] = [];
  for (const op of ops) {
    const input = purchaseInput(op);
    if (!input || !input.lines.some((l) => vetoed.has(l.product_id))) {
      out.push(op);
      continue;
    }
    const lines = input.lines.filter((l) => !vetoed.has(l.product_id));
    if (lines.length) out.push(draftOpFrom(await previewOp(deps.registry, ctx, plannerPrincipal, { action: op.action, input: { ...input, lines } })));
  }
  // A cap only accompanies a PO line for the same SKU: vetoed (or dropped) lines take their cap with them.
  return pruneCaps(out);
}

/**
 * When `max_total_value` denies, a per-vendor budget: the cap (minus an 8% margin (planners round up to whole cases)) split
 * proportionally to each vendor's current draft value.
 */
async function vendorBudgets(
  rules: PolicyRuleSource,
  policy: PolicyEvaluation,
  previews: readonly { value: number | null }[],
  ops: readonly DraftOp[],
): Promise<Map<string, { budget: number; current: number }>> {
  const out = new Map<string, { budget: number; current: number }>();
  if (!policy.reasons.some((r) => r.rule === 'max_total_value' && r.outcome === 'deny')) return out;
  const rule = (await rules.list()).find((r) => r.key === 'max_total_value' && r.enabled !== false);
  const cap = z.object({ max: z.number() }).safeParse(rule?.params);
  if (!cap.success) return out;
  const values = previews.map((p) => p.value ?? 0);
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return out;
  const factor = (cap.data.max * 0.92) / total;
  ops.forEach((op, i) => {
    const vendor = opVendorId(op);
    if (!vendor) return;
    const prev = out.get(vendor) ?? { budget: 0, current: 0 };
    const v = values[i] ?? 0;
    out.set(vendor, { current: prev.current + v, budget: Math.floor((prev.budget + v * factor) * 100) / 100 });
  });
  return out;
}

// ── steps ───────────────────────────────────────────────────────────────────────────────────────

export function createRestockSteps(deps: RestockDeps) {
  const prepare = createStep({
    id: 'prepare',
    description: 'Resolve locations and vendor lead times for the run scope',
    inputSchema: RestockTriggerSchema,
    outputSchema: z.array(AnalyseTaskSchema),
    execute: async ({ inputData: trigger }) => {
      const ctx = deps.contexts().read;
      const client = ctx.connectors.distru;
      const all = await client.listAll(client.listLocations, {});
      const locations = all
        .map((l) => ({ id: l.id, name: l.name ?? l.id }))
        .filter((l) => !trigger.locationIds?.length || trigger.locationIds.includes(l.id));
      if (!locations.length) throw new Error(`No locations match ${JSON.stringify(trigger.locationIds ?? [])}`);
      const vendors = VendorsSchema.parse(
        await deps.registry.runReadTool(ctx, analystPrincipal, 'distru.vendors', trigger.vendorIds?.length ? { vendor_ids: trigger.vendorIds } : {}),
      ).vendors.map((v) => ({ id: v.id, name: v.name, lead_time_days: v.lead_time_days, purchase_order_email: v.purchase_order_email }));
      // Deterministic pre-check (no model): wholesale velocity + retail signals for the whole scope. When
      // nothing is at risk anywhere, no location is analysed and the run ends `nothing_to_order` with zero
      // LLM calls. The candidates also go to the merge step (SKUs the Analyst misses are added in code).
      const scan = await scanDemand({ registry: deps.registry, ctx, locations, vendors, scope: { productIds: trigger.productIds, vendorIds: trigger.vendorIds } });
      const total = Object.values(scan.byLocation).reduce((n, c) => n + c.length, 0);
      if (total === 0) return [];
      return locations.map((location) => ({ trigger, location, vendors, candidates: scan.byLocation[location.id] ?? [] }));
    },
  });

  const analyseLocation = createStep({
    id: 'analyse-location',
    description: 'Inventory Analyst for one location → ranked at-risk SKUs',
    inputSchema: AnalyseTaskSchema,
    outputSchema: AnalyseResultSchema,
    execute: async ({ inputData, mastra, tracingContext }) => {
      const { object, trace } = await callAgent({
        mastra,
        agent: 'inventoryAnalyst',
        prompt: inventoryAnalystPrompt({
          location: inputData.location,
          vendors: inputData.vendors,
          productIds: inputData.trigger.productIds,
          vendorIds: inputData.trigger.vendorIds,
          scenarioNote: inputData.trigger.scenarioNote,
          codeFlagged: inputData.candidates.map((c) => ({ sku: c.row.sku, wholesale: c.wholesale, retail: c.retail, recommendation: c.signal?.recommendation ?? null })),
        }),
        schema: InventoryAnalysisSchema,
        step: 'analyse-location',
        label: `location ${inputData.location.name}`,
        pricing: deps.pricing,
        ...(tracingContext ? { tracingContext } : {}),
      });
      return { location: inputData.location, analysis: object, agentTrace: [trace] };
    },
  });

  const mergeAtRisk = createStep({
    id: 'merge-at-risk',
    description: 'Merge at-risk SKUs across locations and group them by vendor',
    inputSchema: z.array(AnalyseResultSchema),
    outputSchema: z.array(VendorTaskSchema),
    execute: async ({ inputData, getInitData, getStepResultAsync }) => {
      const trigger = RestockTriggerSchema.parse(getInitData());
      const tasks = z.array(AnalyseTaskSchema).parse(await getStepResultAsync('prepare'));
      const vendorRefs = new Map(tasks[0]?.vendors.map((v) => [v.id, v]) ?? []);
      const byKey = new Map<string, AtRiskSku>();
      const vendorName = (id: string, fallback: string) => vendorRefs.get(id)?.name ?? fallback;
      for (const { location, analysis } of inputData) {
        const analysed = analysis.at_risk.map((raw) => ({ ...raw, location_id: raw.location_id ?? location.id, location_name: raw.location_name ?? location.name }));
        // Code-flagged SKUs the Analyst missed are added; flagged_by comes from the numbers, not the model.
        const candidates = tasks.find((t) => t.location.id === location.id)?.candidates ?? [];
        for (const sku of mergeWithScan(analysed, candidates, vendorName)) {
          if (trigger.productIds?.length && !trigger.productIds.includes(sku.product_id)) continue;
          if (trigger.vendorIds?.length && !trigger.vendorIds.includes(sku.vendor_id)) continue;
          const key = `${sku.product_id}|${sku.location_id}`;
          const prev = byKey.get(key);
          if (!prev || sku.urgency_rank < prev.urgency_rank) byKey.set(key, sku);
        }
      }
      const byVendor = new Map<string, AtRiskSku[]>();
      for (const sku of byKey.values()) byVendor.set(sku.vendor_id, [...(byVendor.get(sku.vendor_id) ?? []), sku]);
      const dos = (s: AtRiskSku) => s.adjusted_days_of_supply ?? s.days_of_supply ?? Infinity;
      const guardCtx = { registry: deps.registry, ctx: deps.contexts().read, now: deps.now?.() ?? new Date() };
      const out: VendorTask[] = [];
      for (const [vendorId, items] of byVendor) {
        const vendor = vendorRefs.get(vendorId) ?? { id: vendorId, name: items[0]!.vendor_name, lead_time_days: null, purchase_order_email: null };
        // Allocation guard, in code: SKUs that stock out before this vendor's PO can arrive.
        const { guard, note } = deps.crossTool?.allocationGuard === false ? { guard: [], note: null } : await computeGuard(guardCtx, vendor, items);
        out.push({ trigger, vendor, items: items.sort((a, b) => dos(a) - dos(b)), guard, guardNote: note });
      }
      return out.sort((a, b) => a.vendor.name.localeCompare(b.vendor.name));
    },
  });

  const planVendor = createStep({
    id: 'plan-vendor',
    description: 'Procurement Planner for one vendor → draft PO ops (propose tool → run draft)',
    inputSchema: VendorTaskSchema,
    outputSchema: PlanResultSchema,
    execute: async ({ inputData, mastra, tracingContext }) => {
      const draft = new DraftProposal();
      // Bounded account context (actual lead times, price trends, learned approver preferences) for this vendor's SKUs.
      const context = await contextBlock(deps.registry, deps.contexts().read, plannerPrincipal, { vendorIds: [inputData.vendor.id], productIds: inputData.items.map((i) => i.product_id) });
      const { object, trace } = await callAgent({
        mastra,
        agent: 'procurementPlanner',
        prompt: plannerPrompt({ vendor: inputData.vendor, items: inputData.items, guard: inputData.guard, scenarioNote: inputData.trigger.scenarioNote, context }),
        schema: PlannerResultSchema,
        step: 'plan-vendor',
        label: `vendor ${inputData.vendor.name}`,
        draft,
        pricing: deps.pricing,
        ...(tracingContext ? { tracingContext } : {}),
      });
      // A Planner run is scoped to one vendor: drafts for any other vendor (or caps on others' SKUs) are discarded.
      const productIds = inputData.items.map((i) => i.product_id);
      const ops = pruneCaps(draft.ops.filter((op) => opBelongsTo(op, inputData.vendor.id, productIds)));
      return { vendor: inputData.vendor, ops, result: object, agentTrace: [trace] };
    },
  });

  const collectPlan = createStep({
    id: 'collect-plan',
    description: 'Combine every vendor draft into the review state',
    inputSchema: z.array(PlanResultSchema),
    outputSchema: ReviewStateSchema,
    execute: async ({ inputData, getInitData, getStepResultAsync }) => {
      const trigger = RestockTriggerSchema.parse(getInitData());
      const analyses = z.array(AnalyseResultSchema).parse(await getStepResultAsync('analyse-location'));
      const vendors = z.array(VendorTaskSchema).parse(await getStepResultAsync('merge-at-risk'));
      return {
        trigger,
        round: 0,
        revisions: 0,
        ops: inputData.flatMap((p) => p.ops),
        vendors,
        atRisk: vendors.flatMap((v) => v.items),
        vetoed: [],
        suspicious: mergeFlags(...analyses.map((a) => a.analysis.suspicious_text), ...inputData.map((p) => p.result.suspicious_text)),
        policy: null,
        critiques: [],
        analysisSummaries: analyses.map((a) => `${a.location.name}: ${a.analysis.summary}`),
        plannerSummaries: inputData.map((p) => ({ vendor: p.vendor.name, summary: p.result.summary })),
        plannerHeadlines: inputData.map((p) => ({ vendor_id: p.vendor.id, title: p.result.title, summary: p.result.summary })),
        complianceSummary: null,
        done: vendors.length === 0,
        outcome: vendors.length === 0 ? ('empty' as const) : ('pending' as const),
        agentTrace: [...analyses.flatMap((a) => a.agentTrace), ...inputData.flatMap((p) => p.agentTrace)],
      };
    },
  });

  const reviewRound = createStep({
    id: 'review-round',
    description: 'Compliance veto → plan guard → policy dry-run → (deny) Policy Critic → Planner revision',
    inputSchema: ReviewStateSchema,
    outputSchema: ReviewStateSchema,
    execute: async ({ inputData: state, mastra, tracingContext }): Promise<ReviewState> => {
      const round = state.round + 1;
      const trace: AgentTraceEntry[] = [...state.agentTrace];
      const ctx = deps.contexts().read;
      const common = { mastra, pricing: deps.pricing, step: 'review-round', round, ...(tracingContext ? { tracingContext } : {}) };

      const lines = linesOf(state.ops);
      if (!lines.length) return { ...state, round, done: true, outcome: 'empty' };

      // a) Compliance: the Reviewer's verdicts, backed by the deterministic check (blocked ⇒ veto).
      const productIds = uniq(lines.map((l) => l.product_id));
      const checked: z.infer<typeof ComplianceStatusSchema>['products'] = [];
      for (let i = 0; i < productIds.length; i += 25) {
        const out = await deps.registry.runReadTool(ctx, reviewerPrincipal, 'distru.compliance_check', { product_ids: productIds.slice(i, i + 25) });
        checked.push(...ComplianceStatusSchema.parse(out).products);
      }
      const skuOf = new Map(state.atRisk.map((s) => [s.product_id, s.sku]));
      const { object: review, trace: reviewTrace } = await callAgent({
        ...common,
        agent: 'complianceReviewer',
        label: `compliance review (round ${round})`,
        prompt: complianceReviewPrompt(lines.map((l) => ({ product_id: l.product_id, sku: skuOf.get(l.product_id) ?? null, vendor_id: l.vendor_id, location_id: l.location_id, quantity: l.quantity }))),
        schema: ComplianceReviewSchema,
        spent: trace,
      });
      trace.push(reviewTrace);

      const vetoes = new Map<string, { reasons: string[]; agent: boolean; check: boolean; sku: string | null }>();
      for (const v of review.lines) {
        if (v.verdict !== 'veto' || !productIds.includes(v.product_id)) continue;
        vetoes.set(v.product_id, { reasons: v.reasons, agent: true, check: false, sku: v.sku });
      }
      for (const p of checked) {
        if (p.status !== 'blocked') continue;
        const prev = vetoes.get(p.product_id);
        vetoes.set(p.product_id, { reasons: uniq([...(prev?.reasons ?? []), ...p.reasons]), agent: prev?.agent ?? false, check: true, sku: p.sku });
      }
      const newlyVetoed: VetoedLine[] = lines
        .filter((l) => vetoes.has(l.product_id))
        .map((l) => {
          const v = vetoes.get(l.product_id)!;
          return {
            product_id: l.product_id,
            sku: v.sku ?? skuOf.get(l.product_id) ?? null,
            vendor_id: l.vendor_id,
            location_id: l.location_id,
            quantity: l.quantity,
            reasons: v.reasons,
            source: v.agent && v.check ? ('both' as const) : v.agent ? ('compliance-reviewer' as const) : ('compliance_check' as const),
          };
        });
      const vetoed = [...state.vetoed, ...newlyVetoed];
      let ops = await dropVetoed(deps, state.ops, new Set(vetoed.map((v) => v.product_id)));
      const suspicious = mergeFlags(state.suspicious, review.suspicious_text);
      const base = { ...state, round, vetoed, suspicious, complianceSummary: review.summary };

      if (!ops.length) return { ...base, ops, policy: null, done: true, outcome: 'empty', agentTrace: trace };

      // b) Deterministic plan guard + c) policy dry-run (same rules the harness will apply).
      const previews = await Promise.all(ops.map((op) => previewOp(deps.registry, ctx, plannerPrincipal, { action: op.action, input: op.input })));
      const policy = withGuard(await dryRunPolicy(deps.policyRules, plannerPrincipal, previews), guardFindings(ops, state.atRisk, state.vendors));

      if (policy.outcome !== 'deny') return { ...base, ops, policy, done: true, outcome: 'ready', agentTrace: trace };
      if (state.revisions >= MAX_REVISIONS) return { ...base, ops, policy, done: true, outcome: 'exhausted', agentTrace: trace };

      // d) Denied: the Policy Critic explains and instructs; the Planner revises the affected vendors.
      const { object: critique, trace: criticTrace } = await callAgent({
        ...common,
        agent: 'policyCritic',
        label: `policy critique (round ${round})`,
        prompt: policyCriticPrompt({
          evaluation: policy,
          ops: ops.map((op) => ({ vendor_id: opVendorId(op), summary: op.summary, value: op.value, input: op.input })),
          atRisk: state.atRisk.map((s) => ({ product_id: s.product_id, sku: s.sku, vendor_id: s.vendor_id, days_of_supply: s.days_of_supply, suggested_qty: s.suggested_qty })),
          round,
        }),
        schema: PolicyCritiqueSchema,
        spent: trace,
      });
      trace.push(criticTrace);

      const draftVendors = uniq(ops.map(opVendorId).filter((v): v is string => v !== null));
      const targeted = critique.revisions.filter((r) => draftVendors.includes(r.vendor_id));
      let instructions = targeted.length ? targeted : draftVendors.map((vendor_id) => ({ vendor_id, instruction: critique.explanation }));
      // Maths in code, not in the prompt: when the total cap is breached, every vendor gets a hard budget
      // proportional to its share (with a small margin), so one revision round converges.
      const budgets = await vendorBudgets(deps.policyRules, policy, previews, ops);
      if (budgets.size) {
        const byVendor = new Map(instructions.map((i) => [i.vendor_id, i.instruction]));
        instructions = [...budgets.entries()].map(([vendor_id, b]) => ({
          vendor_id,
          instruction: `${byVendor.get(vendor_id) ?? critique.explanation} HARD BUDGET (computed by the policy engine): your POs for this vendor must total at most ${money(b.budget)} (currently ${money(b.current)}). Cut the least urgent lines or quantities first.`,
        }));
      }
      const denyReasons = policy.reasons.filter((r) => r.outcome === 'deny').map((r) => `${r.rule}: ${r.message}`);
      const vetoedIds = vetoed.map((v) => v.product_id);

      const revised = await Promise.all(
        instructions.map(async ({ vendor_id, instruction }) => {
          const task: VendorTask | undefined = state.vendors.find((v) => v.vendor.id === vendor_id);
          const productIds = task?.items.map((i) => i.product_id) ?? [];
          const current = ops.filter((op) => opBelongsTo(op, vendor_id, productIds));
          const draft = new DraftProposal(current);
          const { object, trace: t } = await callAgent({
            ...common,
            agent: 'procurementPlanner',
            label: `vendor ${task?.vendor.name ?? vendor_id} (revision ${state.revisions + 1})`,
            prompt: plannerRevisionPrompt({
              vendor: task?.vendor ?? { id: vendor_id, name: vendor_id, lead_time_days: null },
              items: task?.items ?? [],
              guard: task?.guard ?? [],
              previous: current.map((op) => ({ summary: op.summary, value: op.value, input: op.input })),
              instruction,
              policyReasons: denyReasons,
              vetoedProductIds: vetoedIds,
              context: await contextBlock(deps.registry, ctx, plannerPrincipal, { vendorIds: [vendor_id], productIds }),
            }),
            schema: PlannerResultSchema,
            draft,
            spent: trace,
          });
          return { vendor_id, ops: draft.ops.filter((op) => opBelongsTo(op, vendor_id, productIds)), result: object, trace: t };
        }),
      );
      const revisedVendors = new Set(revised.map((r) => r.vendor_id));
      const ownedByRevised = (op: DraftOp) => [...revisedVendors].some((v) => opBelongsTo(op, v, state.vendors.find((t) => t.vendor.id === v)?.items.map((i) => i.product_id) ?? []));
      ops = [...ops.filter((op) => !ownedByRevised(op)), ...revised.flatMap((r) => r.ops)];
      // A revision can never re-add a vetoed product.
      ops = await dropVetoed(deps, ops, new Set(vetoedIds));
      trace.push(...revised.map((r) => r.trace));

      return {
        ...base,
        ops,
        policy,
        revisions: state.revisions + 1,
        critiques: [...state.critiques, { round, explanation: critique.explanation, revisions: instructions }],
        plannerHeadlines: [
          ...state.plannerHeadlines.filter((h) => !revised.some((r) => r.vendor_id === h.vendor_id)),
          ...revised.map((r) => ({ vendor_id: r.vendor_id, title: r.result.title, summary: r.result.summary })),
        ],
        plannerSummaries: [
          ...state.plannerSummaries,
          ...revised.map((r) => ({ vendor: state.vendors.find((v) => v.vendor.id === r.vendor_id)?.vendor.name ?? r.vendor_id, summary: `Revision ${state.revisions + 1}: ${r.result.summary}` })),
        ],
        suspicious: mergeFlags(suspicious, ...revised.map((r) => r.result.suspicious_text)),
        done: false,
        outcome: 'pending',
        agentTrace: trace,
      };
    },
  });

  const propose = createStep({
    id: 'propose',
    description: 'Create the one harness proposal for the run (policy evaluated by the harness)',
    inputSchema: ReviewStateSchema,
    outputSchema: ProposeResultSchema,
    execute: async ({ inputData: state, runId, getStepResultAsync }) => {
      const outcome = state.outcome === 'pending' ? 'exhausted' : state.outcome;
      if (!state.ops.length) {
        return { proposalId: null, proposalStatus: null, outcome: 'empty' as const, totalValue: null, agentTrace: state.agentTrace };
      }
      const existing = await deps.findProposalByRunId?.(runId);
      if (existing) {
        // A retried step: the approval request may not have been posted yet. Idempotent (Slack updates
        // the stored message instead of posting a second one).
        await deps.notifier?.proposalCreated(existing);
        return { proposalId: existing.id, proposalStatus: existing.status, outcome, totalValue: totalValue(existing.ops), agentTrace: state.agentTrace };
      }
      // Cross-tool assembly (code): per PO → its buyer cap(s) → vendor email → receiving task.
      const ctx = deps.contexts().read;
      const guard = state.vendors.flatMap((v) => v.guard);
      const assembled = await assembleProposal({
        registry: deps.registry,
        ctx,
        ops: state.ops,
        vendors: state.vendors.map((v) => v.vendor),
        atRisk: state.atRisk,
        guard,
        now: deps.now?.() ?? new Date(),
        runId,
        options: deps.crossTool ?? {},
      });
      const pos = state.ops.filter((op) => op.action === PURCHASE_ACTION);
      const count = (action: string) => assembled.ops.filter((o) => o.action === action).length;
      const total = pos.every((op) => op.value !== null) ? pos.reduce((s, op) => s + (op.value ?? 0), 0) : null;
      const vendorNames = uniq(pos.map((op) => state.vendors.find((v) => v.vendor.id === opVendorId(op))?.vendor.name ?? opVendorId(op) ?? '?'));
      const extras = [
        count(CAP_ACTION) ? `${count(CAP_ACTION)} buyer cap${count(CAP_ACTION) === 1 ? '' : 's'}` : null,
        count(EMAIL_ACTION) ? `${count(EMAIL_ACTION)} vendor email${count(EMAIL_ACTION) === 1 ? '' : 's'}` : null,
        count(TASK_ACTION) ? `${count(TASK_ACTION)} receiving task${count(TASK_ACTION) === 1 ? '' : 's'}` : null,
      ].filter(Boolean);
      // Headline: the Planner's title/summary when exactly one vendor is ordered and it passes the code
      // validator (numbers, dates, vendors, no instructions, no echo of untrusted text); else a template.
      const longSummary = `${pos.length} PO${pos.length === 1 ? '' : 's'} (${money(total)}) for ${vendorNames.join(', ')}${extras.length ? ` + ${extras.join(', ')}` : ''}.`;
      const poVendorIds = uniq(pos.map(opVendorId).filter((v): v is string => v !== null));
      const poLines = linesOf(pos);
      const locationNames = uniq(poLines.map((l) => state.atRisk.find((a) => a.location_id === l.location_id)?.location_name ?? l.location_id));
      const allVendors = z.array(AnalyseTaskSchema).safeParse(await getStepResultAsync('prepare'));
      const headlineFacts: HeadlineFacts = {
        money: [total ?? 0, ...pos.map((op) => op.value ?? 0), ...pos.flatMap((op) => purchaseInput(op)?.lines.flatMap((l) => [l.unit_price, l.unit_price * l.quantity]) ?? [])],
        numbers: [
          ...poLines.map((l) => l.quantity),
          pos.length,
          poVendorIds.length,
          uniq(poLines.map((l) => l.product_id)).length,
          poLines.length,
          assembled.ops.length,
          count(CAP_ACTION),
          count(EMAIL_ACTION),
          count(TASK_ACTION),
          locationNames.length,
          ...guard.map((g) => g.cap),
          ...state.vendors.map((v) => v.vendor.lead_time_days ?? 14),
        ],
        poNumbers: [],
        // Receive dates (today + each vendor's lead time), as the hand-off tasks use them.
        dates: state.vendors.map((v) => new Date((deps.now?.() ?? new Date()).getTime() + (v.vendor.lead_time_days ?? 14) * 86_400_000).toISOString().slice(0, 10)),
        vendorNames,
        knownVendorNames: allVendors.success ? (allVendors.data[0]?.vendors.map((v) => v.name) ?? []) : [],
        untrusted: [...untrustedTextsIn(state.agentTrace), ...state.suspicious.map((s) => s.excerpt)],
      };
      const single = poVendorIds.length === 1 ? (state.plannerHeadlines.find((h) => h.vendor_id === poVendorIds[0]) ?? null) : null;
      const headline = chooseHeadline(single, { title: restockTemplateTitle({ vendors: vendorNames, skuCount: uniq(poLines.map((l) => l.product_id)).length, locations: locationNames }), summary: longSummary }, headlineFacts);
      const title = headline.title;
      const guardNotes = uniq(state.vendors.map((v) => v.guardNote).filter((n): n is string => Boolean(n)));
      // Each computed cap: proposed by the Planner, backfilled by the workflow, or dropped (its SKU is not on any PO).
      const capped = new Map(assembled.ops.filter((o) => o.action === CAP_ACTION).map((o) => [z.object({ id: z.string() }).parse(o.input).id, o.source]));
      const guardStatus = guard.map((g) => ({ ...g, status: capped.get(g.product_id) ?? ('dropped: not ordered' as const) }));
      const spend = sumTrace(state.agentTrace);
      const rationale = [
        `Triggered by ${state.trigger.triggeredBy}${state.trigger.scenarioNote ? `: ${state.trigger.scenarioNote}` : ''}.`,
        '## Inventory analysis',
        ...state.analysisSummaries,
        '## Purchase plan',
        ...state.plannerSummaries.map((p) => `${p.vendor}: ${p.summary}`),
        guard.length
          ? `## Allocation guard (per-buyer menu caps, computed in code)\n${guardStatus.map((g) => `- ${g.reason}${g.current_cap !== null ? ` (current cap ${g.current_cap})` : ''} [${g.status}]`).join('\n')}${assembled.backfilledCaps.length ? `\nAdded by the workflow (the Planner did not propose them): ${assembled.backfilledCaps.join(', ')}` : ''}`
          : null,
        count(EMAIL_ACTION) || count(TASK_ACTION)
          ? `## Hand-offs\nEach PO is followed by its vendor email and a receiving task; both reference the PO number with {{op:N.purchase_number}}, resolved from the PO when it is written (the diff shows the placeholder).`
          : null,
        ...guardNotes,
        ...assembled.notes,
        state.complianceSummary ? `## Compliance\n${state.complianceSummary}` : null,
        state.vetoed.length ? `Vetoed lines: ${state.vetoed.map((v) => `${v.sku ?? v.product_id} (${v.reasons[0] ?? 'blocked'})`).join('; ')}` : null,
        state.critiques.length ? `## Policy revisions\n${state.critiques.map((c) => `Round ${c.round}: ${c.explanation}`).join('\n')}` : null,
        outcome === 'exhausted' ? `Policy still denies after ${MAX_REVISIONS} revisions; proposed for the record (it cannot be executed).` : null,
        state.suspicious.length ? `Ignored suspicious ERP text: ${state.suspicious.map((s) => `${s.sku ?? s.product_id ?? '?'} (${s.source})`).join(', ')}` : null,
      ]
        .filter((s): s is string => Boolean(s))
        .join('\n');
      const proposal = await deps.harness.propose({
        ctx: deps.contexts().read,
        principal: plannerPrincipal,
        ops: assembled.ops.map((op) => ({ action: op.action, input: op.input })),
        title,
        ...(headline.summary ? { summary: headline.summary } : {}),
        rationale,
        meta: {
          ...headline.meta,
          workflowId: RESTOCK_WORKFLOW_ID,
          workflowRunId: runId,
          trigger: state.trigger,
          reviewRounds: state.round,
          revisions: state.revisions,
          reviewOutcome: outcome,
          dryRunPolicy: state.policy,
          vetoedLines: state.vetoed,
          suspiciousText: state.suspicious,
          critiques: state.critiques,
          allocationGuard: guardStatus,
          // Why each SKU is in the plan: wholesale (Distru), retail (Headset) or both.
          atRisk: state.atRisk.map((a) => ({
            product_id: a.product_id,
            sku: a.sku,
            location: a.location_name,
            vendor: a.vendor_name,
            flagged_by: a.flagged_by,
            reorder_status: a.reorder_status,
            days_of_supply: a.days_of_supply,
            adjusted_days_of_supply: a.adjusted_days_of_supply,
            retail_signal: a.retail_signal,
            retail_growth_3w_pct: a.retail_growth_3w_pct,
            recommendation: a.recommendation,
          })),
          crossTool: assembled.ops.map((o, index) => ({ index, action: o.action, forPo: o.forPo, source: o.source })),
          agentTrace: state.agentTrace.map((t) => ({ agent: t.agent, label: t.label, round: t.round, status: t.status, tokens: t.tokens.total, costUsd: t.costUsd, toolCalls: t.toolCalls.length })),
          spend,
        },
      });
      await deps.notifier?.proposalCreated(proposal);
      return { proposalId: proposal.id, proposalStatus: proposal.status, outcome, totalValue: totalValue(proposal.ops), agentTrace: state.agentTrace };
    },
  });

  const awaitDecision = createStep({
    id: AWAIT_DECISION_STEP,
    description: 'Wait for exactly one human decision (skipped when auto-approved or denied)',
    inputSchema: ProposeResultSchema,
    outputSchema: DecisionResultSchema,
    suspendSchema: SuspendSchema,
    resumeSchema: RestockResumeSchema,
    execute: async ({ inputData, suspend }) => {
      if (!inputData.proposalId) return { proposalId: null, decision: 'none' as const, proposalStatus: null };
      // The proposal (not the resume payload) is the source of truth for the decision.
      const p = await deps.harness.get(inputData.proposalId);
      switch (p.status) {
        case 'auto_approved':
        case 'approved':
        case 'executing':
        case 'executed':
        case 'failed':
          return { proposalId: p.id, decision: 'approved' as const, proposalStatus: p.status };
        case 'rejected':
          return { proposalId: p.id, decision: 'rejected' as const, proposalStatus: p.status };
        case 'denied':
          return { proposalId: p.id, decision: 'denied' as const, proposalStatus: p.status };
        default:
          // pending_approval (first visit, or a spurious resume): wait (again).
          return await suspend({ proposalId: p.id, status: p.status, title: p.title });
      }
    },
  });

  const execute = createStep({
    id: 'execute',
    description: 'harness.execute: idempotent writes (one per op), verify-after-write, audit',
    inputSchema: DecisionResultSchema,
    outputSchema: ExecuteResultSchema,
    execute: async ({ inputData }) => {
      if (inputData.decision !== 'approved' || !inputData.proposalId) return { ...inputData, executed: false };
      // Inline step runner: this Mastra step is the durable boundary. Re-running is safe (executed ops
      // are skipped; each write first looks up its idempotency key in Distru).
      const p = await deps.harness.execute({ ctx: deps.contexts().execute, proposalId: inputData.proposalId });
      return { ...inputData, proposalStatus: p.status, executed: true };
    },
  });

  const finalize = createStep({
    id: 'finalize',
    description: 'Check every op executed and verified; report created purchase orders',
    inputSchema: ExecuteResultSchema,
    outputSchema: RestockResultSchema,
    execute: async ({ inputData, getStepResultAsync }): Promise<RestockResult> => {
      if (!inputData.proposalId) {
        const analysed = z.array(z.unknown()).safeParse(await getStepResultAsync('prepare'));
        const prechecked = analysed.success && analysed.data.length === 0;
        return {
          status: 'nothing_to_order',
          proposalId: null,
          proposalStatus: null,
          purchaseOrderIds: [],
          emailIds: [],
          taskIds: [],
          buyerCapProductIds: [],
          verified: false,
          totalValue: null,
          message: prechecked
            ? 'Pre-check: wholesale velocity and retail signals show nothing at risk in scope; no agent was called.'
            : 'No purchase orders needed (nothing at risk, or every line was vetoed).',
        };
      }
      const p = await deps.harness.get(inputData.proposalId);
      const total = totalValue(p.ops);
      if (inputData.decision === 'rejected' || p.status === 'executed' || p.status === 'failed') await deps.notifier?.proposalFinished(p);
      if (inputData.decision === 'rejected' || inputData.decision === 'denied') {
        return {
          status: inputData.decision,
          proposalId: p.id,
          proposalStatus: p.status,
          purchaseOrderIds: [],
          emailIds: [],
          taskIds: [],
          buyerCapProductIds: [],
          verified: false,
          totalValue: total,
          message: inputData.decision === 'rejected' ? `Rejected by ${p.decision?.by.label ?? p.decision?.by.id ?? 'approver'}; nothing was written.` : 'Denied by policy; nothing was written.',
        };
      }
      const idsOf = (action: string) => p.ops.filter((op) => op.action === action && op.status === 'executed').map((op) => op.result?.recordId).filter((id): id is string => typeof id === 'string');
      const ids = idsOf(PURCHASE_ACTION);
      const emailIds = idsOf(EMAIL_ACTION);
      const taskIds = idsOf(TASK_ACTION);
      const buyerCapProductIds = idsOf(CAP_ACTION);
      const verified = p.status === 'executed' && p.ops.every((op) => op.status === 'executed' && (op.result?.mismatches.length ?? 0) === 0);
      const failedOp = p.ops.find((op) => op.status === 'failed');
      return {
        status: p.status === 'executed' ? 'executed' : 'failed',
        proposalId: p.id,
        proposalStatus: p.status,
        purchaseOrderIds: ids,
        emailIds,
        taskIds,
        buyerCapProductIds,
        verified,
        totalValue: total,
        message:
          p.status === 'executed'
            ? `Created/updated ${ids.length} purchase order(s), set ${buyerCapProductIds.length} buyer cap(s), sent ${emailIds.length} vendor email(s), created ${taskIds.length} receiving task(s); read-after-write ${verified ? 'verified' : 'found mismatches'}.`
            : `Execution ${p.status}${failedOp ? ` at op #${failedOp.index} (${failedOp.action})` : ''}: ${p.execution?.error?.message ?? 'see audit trail'}. Earlier ops are done; resume re-runs only what is left.`,
      };
    },
  });

  return { prepare, analyseLocation, mergeAtRisk, planVendor, collectPlan, reviewRound, propose, awaitDecision, execute, finalize };
}

const workflowConfig = {
  id: RESTOCK_WORKFLOW_ID,
  description: 'Restock at-risk SKUs: parallel analysts and planners, compliance + policy review loop, one proposal, human approval, idempotent execution.',
  inputSchema: RestockTriggerSchema,
  outputSchema: RestockResultSchema,
} as const;

const FOREACH = { concurrency: 4 } as const;
const untilDone = async ({ inputData }: { inputData: ReviewState }) => inputData.done;

/** The production workflow: Inngest-backed (every step memoized and retried by Inngest). */
export function createRestockWorkflow(deps: RestockDeps) {
  const s = createRestockSteps(deps);
  return inngestWorkflowKit
    .createWorkflow({ ...workflowConfig, retries: 2 })
    .then(s.prepare)
    .foreach(s.analyseLocation, FOREACH)
    .then(s.mergeAtRisk)
    .foreach(s.planVendor, FOREACH)
    .then(s.collectPlan)
    .dountil(s.reviewRound, untilDone)
    .then(s.propose)
    .then(s.awaitDecision)
    .then(s.execute)
    .then(s.finalize)
    .commit();
}

/** Same steps on Mastra's default (in-process) engine: tests and environments without Inngest. */
export function createRestockWorkflowInProcess(deps: RestockDeps) {
  const s = createRestockSteps(deps);
  return createDefaultWorkflow(workflowConfig)
    .then(s.prepare)
    .foreach(s.analyseLocation, FOREACH)
    .then(s.mergeAtRisk)
    .foreach(s.planVendor, FOREACH)
    .then(s.collectPlan)
    .dountil(s.reviewRound, untilDone)
    .then(s.propose)
    .then(s.awaitDecision)
    .then(s.execute)
    .then(s.finalize)
    .commit();
}

export type { RestockTrigger };
