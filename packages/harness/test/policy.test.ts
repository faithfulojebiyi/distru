import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { definePolicyRule, PolicyEngine, RULE_KEYS, type PolicySubject, type Risk } from '../src';
import { agent } from './fixtures';

const engine = new PolicyEngine();

function subject(ops: Array<{ value?: number | null; risk?: Risk; vendorIds?: string[] | null; resource?: string; action?: string }>): PolicySubject {
  const mapped = ops.map((op, index) => ({
    index,
    action: op.action ?? 'purchases.upsert',
    resource: op.resource ?? 'purchases',
    risk: op.risk ?? 'low',
    payload: {},
    value: op.value === undefined ? 100 : op.value,
    vendorIds: op.vendorIds === undefined ? ['v-acme'] : op.vendorIds,
  }));
  const total = mapped.every((o) => o.value !== null) ? mapped.reduce((s, o) => s + (o.value ?? 0), 0) : null;
  return { principal: agent, ops: mapped, totalValue: total };
}

const rule = (key: string, params: Record<string, unknown> = {}, enabled = true) => ({ key, params, enabled });

describe('PolicyEngine combination', () => {
  test('no rules: default is needs_approval (auto-approval must be granted)', () => {
    const result = engine.evaluate(subject([{}]), []);
    expect(result.outcome).toBe('needs_approval');
    expect(result.reasons.at(-1)?.rule).toBe('default');
  });

  test('deny beats needs_approval beats allow', () => {
    const base = subject([{ value: 50, risk: 'high' }]);
    // allow (auto-approve would grant if low risk) + needs_approval (high risk)
    const needs = engine.evaluate(base, [rule(RULE_KEYS.highRiskRequiresApproval), rule(RULE_KEYS.maxTotalValue, { max: 1000 })]);
    expect(needs.outcome).toBe('needs_approval');

    const denied = engine.evaluate(base, [rule(RULE_KEYS.highRiskRequiresApproval), rule(RULE_KEYS.maxTotalValue, { max: 10 })]);
    expect(denied.outcome).toBe('deny');

    const allowed = engine.evaluate(subject([{ value: 50 }]), [rule(RULE_KEYS.autoApproveBelow, { maxValue: 100 }), rule(RULE_KEYS.highRiskRequiresApproval)]);
    expect(allowed.outcome).toBe('allow');
  });

  test('disabled rules are skipped', () => {
    expect(engine.evaluate(subject([{ value: 5000 }]), [rule(RULE_KEYS.maxTotalValue, { max: 10 }, false)]).outcome).toBe('needs_approval');
  });

  test('fails closed on unknown rules and invalid params', () => {
    const unknown = engine.evaluate(subject([{}]), [rule('no_such_rule')]);
    expect(unknown.outcome).toBe('deny');
    expect(unknown.reasons[0]?.message).toContain('Unknown policy rule');

    const invalid = engine.evaluate(subject([{}]), [rule(RULE_KEYS.maxTotalValue, { max: 'lots' })]);
    expect(invalid.outcome).toBe('deny');
    expect(invalid.reasons[0]?.message).toContain('Invalid params');
  });

  test('custom rules can be registered; duplicate keys rejected', () => {
    const custom = new PolicyEngine().register(
      definePolicyRule({
        key: 'no_weekend_writes',
        description: 'test',
        params: z.object({ weekend: z.boolean() }),
        evaluate: (_s, { weekend }) => (weekend ? [{ outcome: 'deny', message: 'No writes on weekends' }] : []),
      }),
    );
    expect(custom.evaluate(subject([{}]), [rule('no_weekend_writes', { weekend: true })]).outcome).toBe('deny');
    expect(() => custom.register(definePolicyRule({ key: 'no_weekend_writes', description: '', params: z.object({}), evaluate: () => [] }))).toThrow();
  });
});

describe('built-in rules', () => {
  test('max_total_value: sums across ops; unknown value needs approval', () => {
    const cap = [rule(RULE_KEYS.maxTotalValue, { max: 250 })];
    expect(engine.evaluate(subject([{ value: 100 }, { value: 100 }]), cap).reasons[0]).toMatchObject({ outcome: 'pass' });
    const over = engine.evaluate(subject([{ value: 200 }, { value: 100 }]), cap);
    expect(over.outcome).toBe('deny');
    expect(over.reasons[0]?.message).toBe('Total $300.00 exceeds cap $250.00');
    expect(engine.evaluate(subject([{ value: null }]), cap).outcome).toBe('needs_approval');
  });

  test('allowed_actions: resources and action names', () => {
    const r = [rule(RULE_KEYS.allowedActions, { resources: ['purchases'], actions: ['purchases.upsert'] })];
    expect(engine.evaluate(subject([{ resource: 'invoices', action: 'invoices.void' }]), r).outcome).toBe('deny');
    expect(engine.evaluate(subject([{ action: 'purchases.delete' }]), r).outcome).toBe('deny');
    const ok = engine.evaluate(subject([{}]), r);
    expect(ok.reasons[0]?.outcome).toBe('pass');
  });

  test('vendor_allowlist: deny by default, configurable to needs_approval, skips ops without vendors', () => {
    const deny = [rule(RULE_KEYS.vendorAllowlist, { vendorIds: ['v-acme'] })];
    expect(engine.evaluate(subject([{ vendorIds: ['v-shady'] }]), deny).outcome).toBe('deny');
    expect(engine.evaluate(subject([{ vendorIds: null }]), deny).reasons[0]?.outcome).toBe('pass');
    const soft = [rule(RULE_KEYS.vendorAllowlist, { vendorIds: ['v-acme'], onViolation: 'needs_approval' })];
    expect(engine.evaluate(subject([{ vendorIds: ['v-shady'] }]), soft).outcome).toBe('needs_approval');
  });

  test('auto_approve_below: only below threshold, only low risk, only known value', () => {
    const auto = [rule(RULE_KEYS.autoApproveBelow, { maxValue: 500 })];
    expect(engine.evaluate(subject([{ value: 499 }]), auto).outcome).toBe('allow');
    expect(engine.evaluate(subject([{ value: 500 }]), auto).outcome).toBe('needs_approval');
    expect(engine.evaluate(subject([{ value: 10, risk: 'medium' }]), auto).outcome).toBe('needs_approval');
    expect(engine.evaluate(subject([{ value: null }]), auto).outcome).toBe('needs_approval');
  });

  test('auto_approve_below: `amount` param, max_risk medium allows medium but never high', () => {
    const lowOnly = [rule(RULE_KEYS.autoApproveBelow, { amount: 500 })];
    expect(engine.evaluate(subject([{ value: 100, risk: 'medium' }]), lowOnly).outcome).toBe('needs_approval');
    expect(engine.evaluate(subject([{ value: 100, risk: 'low' }]), lowOnly).outcome).toBe('allow');

    const medium = [rule(RULE_KEYS.autoApproveBelow, { amount: 500, max_risk: 'medium' })];
    const ok = engine.evaluate(subject([{ value: 100, risk: 'medium' }, { value: 50, risk: 'low' }]), medium);
    expect(ok.outcome).toBe('allow');
    expect(ok.reasons[0]?.message).toContain('medium risk');
    expect(engine.evaluate(subject([{ value: 499, risk: 'medium' }]), medium).outcome).toBe('allow');
    expect(engine.evaluate(subject([{ value: 500, risk: 'medium' }]), medium).outcome).toBe('needs_approval');
    const high = engine.evaluate(subject([{ value: 10, risk: 'high' }]), medium);
    expect(high.outcome).toBe('needs_approval');
    expect(high.reasons[0]?.message).toContain('above medium risk');
    expect(engine.evaluate(subject([{ value: 10, risk: 'medium' }, { value: 10, risk: 'high' }]), medium).outcome).toBe('needs_approval');
  });

  test('auto_approve_below: invalid params fail closed (high max_risk, missing or conflicting amount)', () => {
    for (const params of [{ amount: 500, max_risk: 'high' }, {}, { amount: 500, maxValue: 400 }]) {
      const r = engine.evaluate(subject([{ value: 1, risk: 'low' }]), [rule(RULE_KEYS.autoApproveBelow, params)]);
      expect(r.outcome).toBe('deny');
      expect(r.reasons[0]?.message).toContain('failing closed');
    }
  });

  test('high_risk_requires_approval: one reason per high-risk op', () => {
    const r = engine.evaluate(subject([{ risk: 'high' }, { risk: 'low' }, { risk: 'high' }]), [rule(RULE_KEYS.highRiskRequiresApproval)]);
    expect(r.outcome).toBe('needs_approval');
    expect(r.reasons.filter((x) => x.outcome === 'needs_approval')).toHaveLength(2);
  });

  test('severity defaults follow outcome', () => {
    const r = engine.evaluate(subject([{ value: 999 }]), [rule(RULE_KEYS.maxTotalValue, { max: 1 })]);
    expect(r.reasons[0]?.severity).toBe('error');
  });
});
