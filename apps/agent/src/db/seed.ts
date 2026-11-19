/**
 * Seeds demo users (idempotent):
 *   operator@demo.dev / demo-password  → role operator
 *   approver@demo.dev / demo-password  → role approver
 * Users are created through Better Auth (so passwords are hashed the same way sign-in expects);
 * the role is then set server-side because clients can never set it.
 */
import { eq } from 'drizzle-orm';
import { auth } from '../auth/auth';
import { db, sql } from './client';
import { policyRule, user, type UserRole } from './schema';

const PASSWORD = 'demo-password';
const DEMO_USERS: Array<{ email: string; name: string; role: UserRole }> = [
  { email: 'operator@demo.dev', name: 'Olivia Operator', role: 'operator' },
  { email: 'approver@demo.dev', name: 'Adam Approver', role: 'approver' },
];

const DEFAULT_POLICY: Array<{ key: string; value: unknown; description: string }> = [
  { key: 'max_po_total', value: { amount: 25000, currency: 'USD' }, description: 'Maximum total of a single PO' },
  { key: 'auto_approve_below', value: { amount: 0, currency: 'USD' }, description: 'Auto-approve threshold (0 = off)' },
  { key: 'allowed_ops', value: [{ resource: 'purchases', op: 'upsert' }], description: 'Resources/ops agents may propose' },
  { key: 'vendor_allowlist', value: [], description: 'Empty = any vendor' },
];

for (const demo of DEMO_USERS) {
  const [existing] = await db.select().from(user).where(eq(user.email, demo.email));
  if (!existing) {
    await auth.api.signUpEmail({ body: { email: demo.email, password: PASSWORD, name: demo.name } });
  }
  await db.update(user).set({ role: demo.role, emailVerified: true }).where(eq(user.email, demo.email));
  console.log(`${existing ? 'updated' : 'created'} ${demo.email} (${demo.role})`);
}

for (const rule of DEFAULT_POLICY) {
  await db.insert(policyRule).values(rule).onConflictDoNothing({ target: policyRule.key });
}
console.log(`policy rules ensured: ${DEFAULT_POLICY.map((r) => r.key).join(', ')}`);

await sql.end();
