/**
 * Seeds demo users (idempotent):
 *   operator@demo.dev / demo-password  → role operator
 *   approver@demo.dev / demo-password  → role approver
 * Users are created through Better Auth's adapter (so passwords are hashed the same way sign-in expects);
 * the role is then set server-side because clients can never set it.
 * Also ensures the default policy rules (harness rule configs). With DEMO_MODE=1 every MCP token is
 * deleted, so a reseed of a public demo leaves no visitor's token working.
 */
import { eq } from 'drizzle-orm';
import { auth } from '../auth/auth';
import { env } from '../env';
import { db, sql } from './client';
import { DEMO_PASSWORD, DEMO_USERS } from './demo-users';
import { mcpToken, user } from './schema';
import { DEFAULT_POLICY, ensureDefaultPolicy } from './seed-policy';

for (const demo of DEMO_USERS) {
  const [existing] = await db.select().from(user).where(eq(user.email, demo.email));
  if (!existing) {
    // Through Better Auth's internals rather than the sign-up endpoint, which production disables.
    const ctx = await auth.$context;
    const created = await ctx.internalAdapter.createUser(
      { email: demo.email, name: demo.name, emailVerified: true },
      { method: 'admin' },
    );
    await ctx.internalAdapter.linkAccount({
      userId: created.id,
      providerId: 'credential',
      accountId: created.id,
      password: await ctx.password.hash(DEMO_PASSWORD),
    });
  }
  await db.update(user).set({ role: demo.role, emailVerified: true }).where(eq(user.email, demo.email));
  console.log(`${existing ? 'updated' : 'created'} ${demo.email} (${demo.role})`);
}

for (const line of await ensureDefaultPolicy(db)) console.log(line);
console.log(`policy rules ensured: ${DEFAULT_POLICY.map((r) => r.key).join(', ')}`);

if (env.DEMO_MODE) {
  const removed = await db.delete(mcpToken).returning({ id: mcpToken.id });
  console.log(`demo mode: deleted ${removed.length} MCP token(s)`);
}

await sql.end();
