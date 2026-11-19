/**
 * Seeds demo users (idempotent):
 *   operator@demo.dev / demo-password  → role operator
 *   approver@demo.dev / demo-password  → role approver
 * Users are created through Better Auth (so passwords are hashed the same way sign-in expects);
 * the role is then set server-side because clients can never set it.
 * Also ensures the default policy rules (harness rule configs).
 */
import { eq } from 'drizzle-orm';
import { auth } from '../auth/auth';
import { db, sql } from './client';
import { user, type UserRole } from './schema';
import { DEFAULT_POLICY, ensureDefaultPolicy } from './seed-policy';

const PASSWORD = 'demo-password';
const DEMO_USERS: Array<{ email: string; name: string; role: UserRole }> = [
  { email: 'operator@demo.dev', name: 'Olivia Operator', role: 'operator' },
  { email: 'approver@demo.dev', name: 'Adam Approver', role: 'approver' },
];

for (const demo of DEMO_USERS) {
  const [existing] = await db.select().from(user).where(eq(user.email, demo.email));
  if (!existing) {
    await auth.api.signUpEmail({ body: { email: demo.email, password: PASSWORD, name: demo.name } });
  }
  await db.update(user).set({ role: demo.role, emailVerified: true }).where(eq(user.email, demo.email));
  console.log(`${existing ? 'updated' : 'created'} ${demo.email} (${demo.role})`);
}

for (const line of await ensureDefaultPolicy(db)) console.log(line);
console.log(`policy rules ensured: ${DEFAULT_POLICY.map((r) => r.key).join(', ')}`);

await sql.end();
