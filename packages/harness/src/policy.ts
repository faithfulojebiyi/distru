import { z } from 'zod';
import { RiskSchema } from './action';
import { PrincipalSchema } from './scopes';

/** Rules are data (stored in `policy_rule`), evaluated by registered implementations. */
export const PolicyRuleConfigSchema = z.object({
  key: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
});
export type PolicyRuleConfig = z.input<typeof PolicyRuleConfigSchema>;

export const PolicyOutcomeSchema = z.enum(['allow', 'needs_approval', 'deny']);
export type PolicyOutcome = z.infer<typeof PolicyOutcomeSchema>;

/** `pass` = check ran and found nothing; shown as a green check, never affects the outcome. */
export const FindingOutcomeSchema = z.enum(['pass', 'allow', 'needs_approval', 'deny']);
export type FindingOutcome = z.infer<typeof FindingOutcomeSchema>;

export const SeveritySchema = z.enum(['info', 'warning', 'error']);
export type Severity = z.infer<typeof SeveritySchema>;

export const PolicyReasonSchema = z.object({
  rule: z.string(),
  outcome: FindingOutcomeSchema,
  severity: SeveritySchema,
  message: z.string(),
});
export type PolicyReason = z.infer<typeof PolicyReasonSchema>;

export const PolicyEvaluationSchema = z.object({
  outcome: PolicyOutcomeSchema,
  reasons: z.array(PolicyReasonSchema),
});
export type PolicyEvaluation = z.infer<typeof PolicyEvaluationSchema>;

/** What rules see: the proposal reduced to policy-relevant facts. */
export const PolicySubjectSchema = z.object({
  principal: PrincipalSchema,
  ops: z.array(
    z.object({
      index: z.number().int(),
      action: z.string(),
      resource: z.string(),
      risk: RiskSchema,
      payload: z.unknown(),
      value: z.number().nullable(),
      vendorIds: z.array(z.string()).nullable(),
    }),
  ),
  /** Sum of op values; null when any op cannot be valued. */
  totalValue: z.number().nullable(),
});
export type PolicySubject = z.infer<typeof PolicySubjectSchema>;

export interface PolicyFinding {
  outcome: FindingOutcome;
  message: string;
  severity?: Severity;
}

/** Rule implementation. Method syntax keeps `AnyPolicyRule` assignable without `any`. */
export interface PolicyRule<TParams> {
  readonly key: string;
  readonly description: string;
  readonly params: z.ZodType<TParams>;
  evaluate(subject: PolicySubject, params: TParams): PolicyFinding[];
}
export type AnyPolicyRule = PolicyRule<unknown>;

export function definePolicyRule<TParams>(rule: PolicyRule<TParams>): PolicyRule<TParams> {
  return rule;
}

const DEFAULT_SEVERITY: Record<FindingOutcome, Severity> = {
  pass: 'info',
  allow: 'info',
  needs_approval: 'warning',
  deny: 'error',
};

const money = (n: number, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);

// ---------------------------------------------------------------------------------------------
// Built-in rules
// ---------------------------------------------------------------------------------------------

export const RULE_KEYS = {
  maxTotalValue: 'max_total_value',
  allowedActions: 'allowed_actions',
  vendorAllowlist: 'vendor_allowlist',
  autoApproveBelow: 'auto_approve_below',
  highRiskRequiresApproval: 'high_risk_requires_approval',
} as const;

export const maxTotalValueRule = definePolicyRule({
  key: RULE_KEYS.maxTotalValue,
  description: 'Deny proposals whose total value exceeds a cap.',
  params: z.object({ max: z.number().nonnegative(), currency: z.string().default('USD') }),
  evaluate(subject, { max, currency }) {
    if (subject.totalValue === null) {
      return [{ outcome: 'needs_approval', message: 'Total value cannot be computed for every op; cap cannot be checked' }];
    }
    if (subject.totalValue > max) {
      return [{ outcome: 'deny', message: `Total ${money(subject.totalValue, currency)} exceeds cap ${money(max, currency)}` }];
    }
    return [{ outcome: 'pass', message: `Total ${money(subject.totalValue, currency)} within cap ${money(max, currency)}` }];
  },
});

export const allowedActionsRule = definePolicyRule({
  key: RULE_KEYS.allowedActions,
  description: 'Deny ops on resources/actions that are not explicitly allowed.',
  params: z.object({ resources: z.array(z.string()).optional(), actions: z.array(z.string()).optional() }),
  evaluate(subject, { resources, actions }) {
    const findings: PolicyFinding[] = [];
    for (const op of subject.ops) {
      if (resources && !resources.includes(op.resource)) {
        findings.push({ outcome: 'deny', message: `Op #${op.index}: resource '${op.resource}' is not allowed` });
      } else if (actions && !actions.includes(op.action)) {
        findings.push({ outcome: 'deny', message: `Op #${op.index}: action '${op.action}' is not allowed` });
      }
    }
    return findings.length ? findings : [{ outcome: 'pass', message: 'All ops target allowed resources and actions' }];
  },
});

export const vendorAllowlistRule = definePolicyRule({
  key: RULE_KEYS.vendorAllowlist,
  description: 'Flag ops that reference vendors outside the allowlist.',
  params: z.object({
    vendorIds: z.array(z.string()),
    onViolation: z.enum(['deny', 'needs_approval']).default('deny'),
  }),
  evaluate(subject, { vendorIds, onViolation }) {
    const allowed = new Set(vendorIds);
    const findings: PolicyFinding[] = [];
    for (const op of subject.ops) {
      for (const vendor of op.vendorIds ?? []) {
        if (!allowed.has(vendor)) {
          findings.push({ outcome: onViolation, message: `Op #${op.index}: vendor '${vendor}' is not on the allowlist` });
        }
      }
    }
    return findings.length ? findings : [{ outcome: 'pass', message: 'All vendors are on the allowlist' }];
  },
});

/** Risks `auto_approve_below` may auto-approve up to. `high` is deliberately not an option. */
export const AutoApproveMaxRiskSchema = z.enum(['low', 'medium']);
export type AutoApproveMaxRisk = z.infer<typeof AutoApproveMaxRiskSchema>;

const RISK_RANK: Record<z.infer<typeof RiskSchema>, number> = { low: 0, medium: 1, high: 2 };

/**
 * `{ amount, currency?, max_risk? }`. `amount` is the threshold (strictly below auto-approves);
 * `maxValue` is accepted as a legacy alias. `max_risk` (default `low`) is the highest op risk that
 * may be auto-approved; high-risk ops can never be.
 */
const AutoApproveBelowParamsSchema = z
  .object({
    amount: z.number().positive().optional(),
    /** Legacy name for `amount`. */
    maxValue: z.number().positive().optional(),
    currency: z.string().default('USD'),
    max_risk: AutoApproveMaxRiskSchema.default('low'),
  })
  .refine((p) => p.amount !== undefined || p.maxValue !== undefined, { message: "'amount' is required", path: ['amount'] })
  .refine((p) => p.amount === undefined || p.maxValue === undefined || p.amount === p.maxValue, {
    message: "'amount' and legacy 'maxValue' disagree",
    path: ['amount'],
  })
  .transform(({ amount, maxValue, currency, max_risk }) => ({ amount: (amount ?? maxValue)!, currency, maxRisk: max_risk }));

export const autoApproveBelowRule = definePolicyRule({
  key: RULE_KEYS.autoApproveBelow,
  description: 'Allow without a human when the total is below a threshold and no op is riskier than max_risk (low by default; never high).',
  params: AutoApproveBelowParamsSchema,
  evaluate(subject, { amount: maxValue, currency, maxRisk }) {
    const risky = subject.ops.filter((op) => RISK_RANK[op.risk] > RISK_RANK[maxRisk]);
    if (risky.length) {
      return [{ outcome: 'needs_approval', message: `Not auto-approvable: ${risky.length} op(s) above ${maxRisk} risk` }];
    }
    if (subject.totalValue === null) {
      return [{ outcome: 'needs_approval', message: 'Not auto-approvable: total value unknown' }];
    }
    if (subject.totalValue >= maxValue) {
      return [{ outcome: 'needs_approval', message: `Total ${money(subject.totalValue, currency)} is at or above auto-approve threshold ${money(maxValue, currency)}` }];
    }
    return [{ outcome: 'allow', message: `${maxRisk === 'low' ? 'Low risk' : 'At most medium risk'} and below auto-approve threshold ${money(maxValue, currency)}` }];
  },
});

export const highRiskRequiresApprovalRule = definePolicyRule({
  key: RULE_KEYS.highRiskRequiresApproval,
  description: 'High-risk ops always need a human decision.',
  params: z.object({}),
  evaluate(subject) {
    const high = subject.ops.filter((op) => op.risk === 'high');
    return high.length
      ? high.map((op) => ({ outcome: 'needs_approval' as const, message: `Op #${op.index} (${op.action}) is high risk` }))
      : [{ outcome: 'pass', message: 'No high-risk ops' }];
  },
});

export const BUILTIN_POLICY_RULES: readonly AnyPolicyRule[] = [
  maxTotalValueRule,
  allowedActionsRule,
  vendorAllowlistRule,
  autoApproveBelowRule,
  highRiskRequiresApprovalRule,
];

// ---------------------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------------------

/**
 * Deterministic policy engine. Combination: deny > needs_approval > allow. With no `allow` grant
 * the outcome is `needs_approval` — a human is the default, auto-approval must be earned.
 * Fails closed: unknown rule keys or invalid params deny.
 */
export class PolicyEngine {
  readonly #rules = new Map<string, AnyPolicyRule>();

  constructor(rules: readonly AnyPolicyRule[] = BUILTIN_POLICY_RULES) {
    for (const rule of rules) this.register(rule);
  }

  register(rule: AnyPolicyRule): this {
    if (this.#rules.has(rule.key)) throw new Error(`Duplicate policy rule '${rule.key}'`);
    this.#rules.set(rule.key, rule);
    return this;
  }

  evaluate(subject: PolicySubject, configs: readonly PolicyRuleConfig[]): PolicyEvaluation {
    const reasons: PolicyReason[] = [];
    for (const raw of configs) {
      const config = PolicyRuleConfigSchema.parse(raw);
      if (!config.enabled) continue;
      const rule = this.#rules.get(config.key);
      if (!rule) {
        reasons.push({ rule: config.key, outcome: 'deny', severity: 'error', message: `Unknown policy rule '${config.key}' (failing closed)` });
        continue;
      }
      const params = rule.params.safeParse(config.params);
      if (!params.success) {
        reasons.push({ rule: config.key, outcome: 'deny', severity: 'error', message: `Invalid params for '${config.key}' (failing closed): ${z.prettifyError(params.error)}` });
        continue;
      }
      for (const f of rule.evaluate(subject, params.data)) {
        reasons.push({ rule: rule.key, outcome: f.outcome, severity: f.severity ?? DEFAULT_SEVERITY[f.outcome], message: f.message });
      }
    }

    const has = (o: FindingOutcome) => reasons.some((r) => r.outcome === o);
    if (has('deny')) return { outcome: 'deny', reasons };
    if (has('needs_approval')) return { outcome: 'needs_approval', reasons };
    if (has('allow')) return { outcome: 'allow', reasons };
    return {
      outcome: 'needs_approval',
      reasons: [...reasons, { rule: 'default', outcome: 'needs_approval', severity: 'info', message: 'No rule granted automatic approval' }],
    };
  }
}
