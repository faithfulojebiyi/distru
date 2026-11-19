/**
 * Default policy rules for `db:seed` (and tests): insert-if-missing by key, so Settings edits survive a
 * re-seed and removed rules stay removed (their soft-deleted row blocks the insert).
 */
import { EMAIL_RECIPIENT_DOMAINS_RULE } from "@ops/connector-email";
import { deepEqual, RULE_KEYS, type PolicyRuleConfig } from "@ops/harness";
import { eq } from "drizzle-orm";
import {
  APP_POLICY_RULES,
  DEFAULT_ALLOWED_ACTIONS,
  DEFAULT_EMAIL_DOMAINS,
} from "../harness/policy";
import type { DB } from "./client";
import { policyRule } from "./schema";

/**
 * Default policy: valid harness `PolicyRuleConfig`s (built-in rule keys from @ops/harness, params
 * checked against each rule's zod schema below so a typo fails the seed, not a proposal).
 */
export const DEFAULT_POLICY: Array<PolicyRuleConfig & { description: string }> =
  [
    {
      key: RULE_KEYS.maxTotalValue,
      params: { max: 25000, currency: "USD" },
      enabled: true,
      description: "Deny proposals whose total exceeds $25,000",
    },
    {
      key: RULE_KEYS.autoApproveBelow,
      params: { amount: 500, max_risk: "medium", currency: "USD" },
      enabled: true,
      description:
        "Auto-approve proposals under $500 whose ops are at most medium risk (never high)",
    },
    {
      key: RULE_KEYS.highRiskRequiresApproval,
      params: {},
      enabled: true,
      description: "High-risk ops always need a human decision",
    },
    {
      key: RULE_KEYS.allowedActions,
      params: { actions: DEFAULT_ALLOWED_ACTIONS },
      enabled: true,
      description:
        "Actions agents may propose (registry names are namespaced by connector)",
    },
    {
      key: EMAIL_RECIPIENT_DOMAINS_RULE,
      params: { domains: DEFAULT_EMAIL_DOMAINS, onViolation: "deny" },
      enabled: true,
      description:
        "Vendor email may only go to these domains (the vendors on file)",
    },
    {
      key: RULE_KEYS.vendorAllowlist,
      params: { vendorIds: [], onViolation: "needs_approval" },
      enabled: false,
      description: "Vendor allowlist (disabled: any vendor)",
    },
  ];

for (const rule of DEFAULT_POLICY) {
  const impl = APP_POLICY_RULES.find((r) => r.key === rule.key);
  if (!impl) throw new Error(`Unknown policy rule '${rule.key}'`);
  impl.params.parse(rule.params);
}

/**
 * One-off upgrade of seeded defaults that were never edited: the old `auto_approve_below` default
 * (`{ maxValue: 500 }`, low risk only) becomes `{ amount: 500, max_risk: 'medium' }` so small Distru
 * POs (medium risk) can auto-approve. Rows edited on the Settings page are left alone.
 */
export const SUPERSEDED_DEFAULTS: Array<{
  key: string;
  params: Record<string, unknown>;
}> = [
  {
    key: RULE_KEYS.autoApproveBelow,
    params: { maxValue: 500, currency: "USD" },
  },
  // Before connectors, the action was registered as `purchases.upsert`; it is now `distru.purchases.upsert`.
  { key: RULE_KEYS.allowedActions, params: { actions: ["purchases.upsert"] } },
  // Before the cross-tool restock (emails, tasks, buyer caps), only POs were allowed.
  {
    key: RULE_KEYS.allowedActions,
    params: { actions: ["distru.purchases.upsert"] },
  },
  // Before the vendor-reply loop (acknowledgement reply through Composio Gmail).
  {
    key: RULE_KEYS.allowedActions,
    params: {
      actions: [
        "distru.purchases.upsert",
        "distru_mcp.mutate_product",
        "email.send_vendor_po",
        "distru.tasks.create",
      ],
    },
  },
];
/**
 * Inserts missing default rules and upgrades never-edited superseded defaults. Idempotent. A rule an
 * approver removed (PUT /api/policy-rules → soft-deleted row) is never re-inserted or upgraded.
 */
export async function ensureDefaultPolicy(db: DB): Promise<string[]> {
  const log: string[] = [];
  for (const old of SUPERSEDED_DEFAULTS) {
    const next = DEFAULT_POLICY.find((r) => r.key === old.key)!;
    const [row] = await db
      .select()
      .from(policyRule)
      .where(eq(policyRule.key, old.key));
    if (row && row.deletedAt === null && deepEqual(row.params, old.params)) {
      await db
        .update(policyRule)
        .set({ params: next.params ?? {}, description: next.description })
        .where(eq(policyRule.key, old.key));
      log.push(
        `upgraded default policy rule ${old.key} → ${JSON.stringify(next.params)}`,
      );
    }
  }

  for (const { key, params, enabled, description } of DEFAULT_POLICY) {
    // Insert-if-missing: edits made on the Settings page survive a re-seed, and a rule removed there
    // keeps its (soft-deleted, `deleted_at`) row, so the conflict on `key` stops it coming back.
    await db
      .insert(policyRule)
      .values({
        key,
        params: params ?? {},
        enabled: enabled ?? true,
        description,
      })
      .onConflictDoNothing({ target: policyRule.key });
  }
  return log;
}
