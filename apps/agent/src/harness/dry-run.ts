import {
  assertScope,
  parseWith,
  PolicyEngine,
  totalValue,
  type FieldChange,
  type OpRequest,
  type PolicyEvaluation,
  type PolicyRuleSource,
  type Principal,
  type Registry,
  type Risk,
} from '@ops/harness';

/**
 * Dry-run helpers: everything `harness.propose` computes for an op (validate → load before → plan →
 * diff → value/vendor facts) and the policy verdict, **without** persisting a proposal or touching
 * the ERP's write path. Used by the `propose_*` tools (instant feedback to the Planner) and by the
 * restock workflow's review loop (policy dry-run before the one real proposal is created).
 */
export interface OpPreview {
  action: string;
  resource: string;
  risk: Risk;
  input: unknown;
  payload: unknown;
  diff: FieldChange[];
  summary: string | null;
  value: number | null;
  vendorIds: string[] | null;
}

export async function previewOp<TCtx>(registry: Registry<TCtx>, ctx: TCtx, principal: Principal, request: OpRequest): Promise<OpPreview> {
  const action = registry.action(request.action);
  assertScope(principal, action.requiredScope);
  const input = parseWith(action.input, request.input, `input for ${action.name}`);
  const before = await action.loadBefore(ctx, input);
  const planned = await action.plan(ctx, input, before);
  const payload = action.payload ? parseWith(action.payload, planned, `planned payload for ${action.name}`) : planned;
  return {
    action: action.name,
    resource: action.resource,
    risk: action.risk,
    input,
    payload,
    diff: action.diff(before, payload),
    summary: (await action.summarize?.(input, payload, ctx, before)) ?? null,
    // Own property only: every object inherits Object.prototype.valueOf (same rule as harness planOp).
    value: Object.hasOwn(action, 'valueOf') ? (action.valueOf?.(payload) ?? null) : null,
    vendorIds: action.vendorIdsOf?.(payload) ?? null,
  };
}

const defaultEngine = new PolicyEngine();

/** The verdict `harness.propose` would reach for these previews, with the same rule source. */
export async function dryRunPolicy(
  rules: PolicyRuleSource,
  principal: Principal,
  previews: readonly OpPreview[],
  engine: PolicyEngine = defaultEngine,
): Promise<PolicyEvaluation> {
  return engine.evaluate(
    {
      principal,
      ops: previews.map((p, index) => ({
        index,
        action: p.action,
        resource: p.resource,
        risk: p.risk,
        payload: p.payload,
        value: p.value,
        vendorIds: p.vendorIds,
      })),
      totalValue: totalValue(previews),
    },
    await rules.list(),
  );
}
