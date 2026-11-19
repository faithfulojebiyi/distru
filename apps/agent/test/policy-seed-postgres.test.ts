/**
 * Policy rules removed with PUT /api/policy-rules stay removed: the repo soft-deletes (`deleted_at`),
 * and the seed (insert-if-missing by key) never resurrects them. Test database only (test/preload.ts).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { userPrincipal } from '@ops/harness';
import postgres from 'postgres';
import { db } from '../src/db/client';
import { policyRule } from '../src/db/schema';
import { ensureDefaultPolicy } from '../src/db/seed-policy';
import { DrizzlePolicyRuleSource } from '../src/harness/policy-rules';
import { APP_POLICY_RULES } from '../src/harness/policy';
import { createPolicyRuleService, DrizzlePolicyRuleRepo } from '../src/services/policy-rules';
import { InMemoryAuditSink } from '@ops/harness';

async function reachable(): Promise<boolean> {
  const probe = postgres(process.env.DATABASE_URL!, { max: 1, connect_timeout: 2, onnotice: () => {} });
  try {
    await probe`select deleted_at from policy_rule limit 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 1 }).catch(() => {});
  }
}
const ok = await reachable();

afterAll(async () => {
  if (ok) await db.delete(policyRule);
});

describe.skipIf(!ok)('policy rules: soft delete + seed (Postgres)', () => {
  test('a rule removed via PUT is not resurrected by the seed; PUT-ing it again restores it', async () => {
    await db.delete(policyRule);
    await ensureDefaultPolicy(db);
    const repo = new DrizzlePolicyRuleRepo(db);
    const service = createPolicyRuleService({ repo, rules: APP_POLICY_RULES, audit: new InMemoryAuditSink() });
    const all = await service.list();
    expect(all.map((r) => r.key)).toContain('vendor_allowlist');

    const approver = userPrincipal('u-ap', 'approver');
    const kept = all.filter((r) => r.key !== 'vendor_allowlist').map(({ key, params, enabled }) => ({ key, params, enabled }));
    await service.replace(approver, kept);
    expect((await service.list()).map((r) => r.key)).not.toContain('vendor_allowlist');

    await ensureDefaultPolicy(db); // re-seed
    expect((await service.list()).map((r) => r.key)).not.toContain('vendor_allowlist');
    expect((await new DrizzlePolicyRuleSource(db).list()).map((r) => r.key)).not.toContain('vendor_allowlist');

    await service.replace(approver, [...kept, { key: 'vendor_allowlist', params: { vendorIds: ['v-1'], onViolation: 'needs_approval' }, enabled: true }]);
    const restored = (await service.list()).find((r) => r.key === 'vendor_allowlist');
    expect(restored).toMatchObject({ params: { vendorIds: ['v-1'] }, enabled: true });
  });
});
