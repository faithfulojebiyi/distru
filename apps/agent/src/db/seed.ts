/**
 * Seeds demo users (idempotent):
 *   operator@demo.dev / demo-password  → role operator
 *   approver@demo.dev / demo-password  → role approver
 * Users are created through Better Auth (so passwords are hashed the same way sign-in expects);
 * the role is then set server-side because clients can never set it.
 * Also ensures the default policy rules (harness rule configs).
 */
import { EMAIL_RECIPIENT_DOMAINS_RULE } from '@ops/connector-email';
import { deepEqual, RULE_KEYS, type PolicyRuleConfig } from '@ops/harness';
import { eq } from 'drizzle-orm';
import { auth } from '../auth/auth';
import { APP_POLICY_RULES, DEFAULT_ALLOWED_ACTIONS, DEFAULT_EMAIL_DOMAINS } from '../harness/policy';
import { db, sql } from './client';
import { policyRule, user, type UserRole } from './schema';

const PASSWORD = 'demo-password';
const DEMO_USERS: Array<{ email: string; name: string; role: UserRole }> = [
  { email: 'operator@demo.dev', name: 'Olivia Operator', role: 'operator' },
  { email: 'approver@demo.dev', name: 'Adam Approver', role: 'approver' },
];

/**
 * Default policy: valid harness `PolicyRuleConfig`s (built-in rule keys from @ops/harness, params
 * checked against each rule's zod schema below so a typo fails the seed, not a proposal).
 */
const DEFAULT_POLICY: Array<PolicyRuleConfig & { description: string }> = [
  {
    key: RULE_KEYS.maxTotalValue,
    params: { max: 25000, currency: 'USD' },
    enabled: true,
    description: 'Deny proposals whose total exceeds $25,000',
  },
  {
    key: RULE_KEYS.autoApproveBelow,
    params: { amount: 500, max_risk: 'medium', currency: 'USD' },
    enabled: true,
    description: 'Auto-approve proposals under $500 whose ops are at most medium risk (never high)',
  },
  {
    key: RULE_KEYS.highRiskRequiresApproval,
    params: {},
    enabled: true,
    description: 'High-risk ops always need a human decision',
  },
  {
    key: RULE_KEYS.allowedActions,
    params: { actions: DEFAULT_ALLOWED_ACTIONS },
    enabled: true,
    description: 'Actions agents may propose (registry names are namespaced by connector)',
  },
  {
    key: EMAIL_RECIPIENT_DOMAINS_RULE,
    params: { domains: DEFAULT_EMAIL_DOMAINS, onViolation: 'deny' },
    enabled: true,
    description: 'Vendor email may only go to these domains (the vendors on file)',
  },
  {
    key: RULE_KEYS.vendorAllowlist,
    params: { vendorIds: [], onViolation: 'needs_approval' },
    enabled: false,
    description: 'Vendor allowlist (disabled: any vendor)',
  },
];

for (const rule of DEFAULT_POLICY) {
  const impl = APP_POLICY_RULES.find((r) => r.key === rule.key);
  if (!impl) throw new Error(`Unknown policy rule '${rule.key}'`);
  impl.params.parse(rule.params);
}

for (const demo of DEMO_USERS) {
  const [existing] = await db.select().from(user).where(eq(user.email, demo.email));
  if (!existing) {
    await auth.api.signUpEmail({ body: { email: demo.email, password: PASSWORD, name: demo.name } });
  }
  await db.update(user).set({ role: demo.role, emailVerified: true }).where(eq(user.email, demo.email));
  console.log(`${existing ? 'updated' : 'created'} ${demo.email} (${demo.role})`);
}

/**
 * One-off upgrade of seeded defaults that were never edited: the old `auto_approve_below` default
 * (`{ maxValue: 500 }`, low risk only) becomes `{ amount: 500, max_risk: 'medium' }` so small Distru
 * POs (medium risk) can auto-approve. Rows edited on the Settings page are left alone.
 */
const SUPERSEDED_DEFAULTS: Array<{ key: string; params: Record<string, unknown> }> = [
  { key: RULE_KEYS.autoApproveBelow, params: { maxValue: 500, currency: 'USD' } },
  // Before connectors, the action was registered as `purchases.upsert`; it is now `distru.purchases.upsert`.
  { key: RULE_KEYS.allowedActions, params: { actions: ['purchases.upsert'] } },
  // Before the cross-tool restock (emails, tasks, buyer caps), only POs were allowed.
  { key: RULE_KEYS.allowedActions, params: { actions: ['distru.purchases.upsert'] } },
  // Before the vendor-reply loop (acknowledgement reply through Composio Gmail).
  { key: RULE_KEYS.allowedActions, params: { actions: ['distru.purchases.upsert', 'distru_mcp.mutate_product', 'email.send_vendor_po', 'distru.tasks.create'] } },
];
for (const old of SUPERSEDED_DEFAULTS) {
  const next = DEFAULT_POLICY.find((r) => r.key === old.key)!;
  const [row] = await db.select().from(policyRule).where(eq(policyRule.key, old.key));
  if (row && deepEqual(row.params, old.params)) {
    await db
      .update(policyRule)
      .set({ params: next.params ?? {}, description: next.description })
      .where(eq(policyRule.key, old.key));
    console.log(`upgraded default policy rule ${old.key} → ${JSON.stringify(next.params)}`);
  }
}

for (const { key, params, enabled, description } of DEFAULT_POLICY) {
  // Insert-if-missing: edits made on the Settings page survive a re-seed.
  await db
    .insert(policyRule)
    .values({ key, params: params ?? {}, enabled: enabled ?? true, description })
    .onConflictDoNothing({ target: policyRule.key });
}
console.log(`policy rules ensured: ${DEFAULT_POLICY.map((r) => r.key).join(', ')}`);

await sql.end();
