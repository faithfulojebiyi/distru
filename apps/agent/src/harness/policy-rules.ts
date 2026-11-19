import type { PolicyRuleConfig, PolicyRuleSource } from '@ops/harness';
import { asc } from 'drizzle-orm';
import type { DB } from '../db/client';
import { policyRule } from '../db/schema';

/**
 * `PolicyRuleSource` over `policy_rule`. Read on every evaluation (no cache) so edits on the
 * Settings page apply to the next proposal. Disabled rows are returned with `enabled: false`; the
 * harness engine skips them. Unknown keys / bad params fail closed inside the engine.
 */
export class DrizzlePolicyRuleSource implements PolicyRuleSource {
  constructor(private readonly db: DB) {}

  async list(): Promise<readonly PolicyRuleConfig[]> {
    const rows = await this.db.select().from(policyRule).orderBy(asc(policyRule.createdAt), asc(policyRule.key));
    return rows.map((r) => ({ key: r.key, params: r.params, enabled: r.enabled }));
  }
}
