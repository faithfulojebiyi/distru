/**
 * `learnFromHistory` (the cron / `context:sync` learning pass) against Postgres: `policy.changed` audit
 * events (no proposal) become `policy_rule_changed` signals, so a seeded cap revision becomes a global
 * memory. Test DB only (test/preload.ts); skips when Postgres is unreachable.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { InMemoryContextStore } from '@ops/context';
import { userPrincipal } from '@ops/harness';
import { inArray } from 'drizzle-orm';
import postgres from 'postgres';
import { learnFromHistory, memoriesList } from '../src/context/app-context';
import { db } from '../src/db/client';
import { auditEvent } from '../src/db/schema';

async function reachable(): Promise<boolean> {
  const probe = postgres(process.env.DATABASE_URL!, { max: 1, connect_timeout: 2, onnotice: () => {} });
  try {
    await probe`select 1 from audit_event limit 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 1 }).catch(() => {});
  }
}
const ok = await reachable();
const ids: string[] = [];

afterAll(async () => {
  if (ok && ids.length) await db.delete(auditEvent).where(inArray(auditEvent.id, ids));
});

describe.skipIf(!ok)('learnFromHistory (Postgres)', () => {
  test('a policy.changed audit event becomes a policy memory; re-running adds no new signal', async () => {
    const id = crypto.randomUUID();
    ids.push(id);
    const actor = userPrincipal('it-approver', 'approver', 'IT Approver');
    await db.insert(auditEvent).values({
      id,
      type: 'policy.changed',
      actor,
      actorKind: actor.kind,
      actorId: actor.id,
      proposalId: null,
      data: { key: 'max_total_value', before: { params: { max: 15000 }, enabled: true }, after: { params: { max: 25000 }, enabled: true } },
      at: new Date(Date.now() - 3 * 86_400_000),
    });

    const store = new InMemoryContextStore();
    const first = await learnFromHistory(db, store);
    expect(first.signals).toBeGreaterThanOrEqual(1);
    const memories = await memoriesList(store, { scope: 'global', limit: 20 });
    const cap = memories.find((m) => m.key === 'policy:max_total_value');
    expect(cap).toBeDefined();
    expect(cap!.statement).toContain('raised from $15,000 to $25,000');
    expect(cap!.evidence.auditIds).toContain(id);
    expect(cap!.effectiveConfidence).toBeGreaterThan(0.9);

    // signals are stored by audit id: a second pass re-learns nothing new
    const again = await learnFromHistory(db, store);
    expect(again.memories).toBe(0);
  });
});
