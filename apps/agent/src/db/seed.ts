/**
 * Seeds demo users (idempotent):
 *   operator@demo.dev / demo-password  → role operator
 *   approver@demo.dev / demo-password  → role approver
 * Users are created through Better Auth (so passwords are hashed the same way sign-in expects);
 * the role is then set server-side because clients can never set it.
 * Also ensures the default policy rules (harness rule configs).
 */
import { BUILTIN_POLICY_RULES, RULE_KEYS, type PolicyRuleConfig } from '@ops/harness';
import { eq } from 'drizzle-orm';
import { auth } from '../auth/auth';
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
    params: { maxValue: 500, currency: 'USD' },
    enabled: true,
    description: 'Auto-approve low-risk proposals under $500',
  },
  {
    key: RULE_KEYS.highRiskRequiresApproval,
    params: {},
    enabled: true,
    description: 'High-risk ops always need a human decision',
  },
  {
    key: RULE_KEYS.allowedActions,
    params: { actions: ['purchases.upsert'] },
    enabled: true,
    description: 'Actions agents may propose',
  },
  {
    key: RULE_KEYS.vendorAllowlist,
    params: { vendorIds: [], onViolation: 'needs_approval' },
    enabled: false,
    description: 'Vendor allowlist (disabled: any vendor)',
  },
];

for (const rule of DEFAULT_POLICY) {
  const impl = BUILTIN_POLICY_RULES.find((r) => r.key === rule.key);
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

for (const { key, params, enabled, description } of DEFAULT_POLICY) {
  // Insert-if-missing: edits made on the Settings page survive a re-seed.
  await db
    .insert(policyRule)
    .values({ key, params: params ?? {}, enabled: enabled ?? true, description })
    .onConflictDoNothing({ target: policyRule.key });
}
console.log(`policy rules ensured: ${DEFAULT_POLICY.map((r) => r.key).join(', ')}`);

await sql.end();
