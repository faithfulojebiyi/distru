import type { PolicyRuleConfig, PolicyRuleSource } from '@ops/harness';
import { asc, isNull } from 'drizzle-orm';
import type { DB } from '../db/client';
import { policyRule } from '../db/schema';

/**
 * `PolicyRuleSource` over `policy_rule`. Read on every evaluation (no cache) so edits on the
 * Settings page apply to the next proposal. Disabled rows are returned with `enabled: false`; the
 * harness engine skips them. Rows removed on the Settings page (`deleted_at` set) are not rules any more. Unknown keys / bad params fail closed inside the engine.
 */
export class DrizzlePolicyRuleSource implements PolicyRuleSource {
  constructor(private readonly db: DB) {}

  async list(): Promise<readonly PolicyRuleConfig[]> {
    const rows = await this.db.select().from(policyRule).where(isNull(policyRule.deletedAt)).orderBy(asc(policyRule.createdAt), asc(policyRule.key));
    return rows.map((r) => ({ key: r.key, params: r.params, enabled: r.enabled }));
  }
}
