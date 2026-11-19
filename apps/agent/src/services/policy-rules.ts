/**
 * Policy rules (`policy_rule`) for the Settings page: list, and replace the whole set (approver only).
 *
 * Every row is validated against the rule implementation the engine will run (`APP_POLICY_RULES`:
 * harness built-ins + connector rules): unknown keys and params that fail the rule's zod schema are
 * refused with 400 instead of being stored (the engine would fail closed on them, denying every
 * proposal). Each changed key is audited as `policy.changed` with before/after (after = null when a
 * rule is removed). Edits apply to the next evaluation (the rule source is read per evaluation).
 */
import { deepEqual, type AnyPolicyRule, type AuditEventInput, type AuditSink, type Principal } from '@ops/harness';
import { asc, eq, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import type { PolicyRule, PolicyRuleInput, PolicyRuleType } from '../api/schemas-ops';
import type { DB } from '../db/client';
import { policyRule } from '../db/schema';

export interface PolicyRuleRepo {
  list(): Promise<PolicyRule[]>;
  /** Upsert `rules` and delete every other row, atomically. */
  replace(rules: Array<Required<Omit<PolicyRuleInput, 'description'>> & { description: string | null }>): Promise<PolicyRule[]>;
}

export class PolicyValidationError extends Error {
  readonly issues: Array<{ key: string; message: string }>;
  constructor(issues: Array<{ key: string; message: string }>) {
    super(`Invalid policy: ${issues.map((i) => `${i.key}: ${i.message}`).join('; ')}`);
    this.name = 'PolicyValidationError';
    this.issues = issues;
  }
}

export interface PolicyRuleServiceDeps {
  repo: PolicyRuleRepo;
  rules: readonly AnyPolicyRule[];
  audit: AuditSink;
  now?: () => Date;
  ids?: () => string;
}

export type PolicyRuleService = ReturnType<typeof createPolicyRuleService>;

export function createPolicyRuleService(deps: PolicyRuleServiceDeps) {
  const now = deps.now ?? (() => new Date());
  const ids = deps.ids ?? (() => crypto.randomUUID());
  const available: PolicyRuleType[] = deps.rules.map((r) => ({
    key: r.key,
    description: r.description,
    paramsSchema: { ...z.toJSONSchema(r.params, { io: 'input', unrepresentable: 'any' }) },
  }));

  return {
    available: () => available,
    list: () => deps.repo.list(),

    async replace(actor: Principal, input: readonly PolicyRuleInput[]): Promise<PolicyRule[]> {
      const issues: Array<{ key: string; message: string }> = [];
      const seen = new Set<string>();
      for (const rule of input) {
        if (seen.has(rule.key)) issues.push({ key: rule.key, message: 'listed more than once' });
        seen.add(rule.key);
        const impl = deps.rules.find((r) => r.key === rule.key);
        if (!impl) {
          issues.push({ key: rule.key, message: `unknown rule (known: ${deps.rules.map((r) => r.key).join(', ')})` });
          continue;
        }
        const parsed = impl.params.safeParse(rule.params ?? {});
        if (!parsed.success) issues.push({ key: rule.key, message: z.prettifyError(parsed.error) });
      }
      if (issues.length) throw new PolicyValidationError(issues);

      const before = new Map((await deps.repo.list()).map((r) => [r.key, r]));
      const next = input.map((r) => ({ key: r.key, params: r.params ?? {}, enabled: r.enabled ?? true, description: r.description ?? before.get(r.key)?.description ?? null }));
      const saved = await deps.repo.replace(next);

      const view = (r: { params: Record<string, unknown>; enabled: boolean } | undefined) => (r ? { params: r.params, enabled: r.enabled } : null);
      const changed = new Set([...before.keys(), ...next.map((r) => r.key)]);
      for (const key of changed) {
        const b = view(before.get(key));
        const a = view(next.find((r) => r.key === key));
        if (deepEqual(b, a)) continue;
        const event: AuditEventInput = { type: 'policy.changed', actor, proposalId: null, data: { key, before: b, after: a } };
        await deps.audit.append({ ...event, id: ids(), at: now().toISOString() });
      }
      return saved;
    },
  };
}

type Row = typeof policyRule.$inferSelect;
const toRule = (r: Row): PolicyRule => ({ key: r.key, params: r.params, enabled: r.enabled, description: r.description, updatedAt: r.updatedAt.toISOString() });

export class DrizzlePolicyRuleRepo implements PolicyRuleRepo {
  constructor(private readonly db: DB) {}

  async list(): Promise<PolicyRule[]> {
    return (await this.db.select().from(policyRule).orderBy(asc(policyRule.createdAt), asc(policyRule.key))).map(toRule);
  }

  async replace(rules: Parameters<PolicyRuleRepo['replace']>[0]): Promise<PolicyRule[]> {
    await this.db.transaction(async (tx) => {
      const keys = rules.map((r) => r.key);
      if (keys.length) await tx.delete(policyRule).where(notInArray(policyRule.key, keys));
      else await tx.delete(policyRule);
      for (const r of rules) {
        const [existing] = await tx.select({ id: policyRule.id }).from(policyRule).where(eq(policyRule.key, r.key));
        if (existing) await tx.update(policyRule).set({ params: r.params, enabled: r.enabled, description: r.description }).where(eq(policyRule.key, r.key));
        else await tx.insert(policyRule).values({ key: r.key, params: r.params, enabled: r.enabled, description: r.description });
      }
    });
    return this.list();
  }
}

export class InMemoryPolicyRuleRepo implements PolicyRuleRepo {
  rows: PolicyRule[];
  constructor(rows: PolicyRule[] = []) {
    this.rows = rows;
  }
  async list(): Promise<PolicyRule[]> {
    return structuredClone(this.rows);
  }
  async replace(rules: Parameters<PolicyRuleRepo['replace']>[0]): Promise<PolicyRule[]> {
    const at = new Date().toISOString();
    this.rows = rules.map((r) => ({ ...r, updatedAt: at }));
    return this.list();
  }
}
