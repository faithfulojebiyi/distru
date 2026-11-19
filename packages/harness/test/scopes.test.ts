import { describe, expect, test } from 'bun:test';
import {
  assertScope,
  DecisionConflictError,
  ForbiddenError,
  hasScope,
  mcpClientPrincipal,
  PrincipalSchema,
  ROLE_SCOPES,
  scopesForRole,
  type Principal,
} from '../src';
import { agent, approver, approver2, operator, poInput, setup } from './fixtures';

describe('scope model', () => {
  test('role → scopes', () => {
    expect(scopesForRole('operator')).toEqual(['read', 'propose']);
    expect(scopesForRole('approver')).toEqual(['read', 'propose', 'approve']);
    expect(ROLE_SCOPES.operator).not.toContain('approve');
    expect(agent.scopes).toEqual(['read', 'propose']);
  });

  test('agents can never approve: schema rejects it, and hand-built principals are still refused', () => {
    expect(PrincipalSchema.safeParse({ kind: 'agent', id: 'a', scopes: ['approve'] }).success).toBe(false);
    const forged: Principal = { kind: 'agent', id: 'evil', scopes: ['read', 'propose', 'approve'] };
    expect(hasScope(forged, 'approve')).toBe(false);
    expect(() => assertScope(forged, 'approve')).toThrow(ForbiddenError);
  });

  test('mcp clients get exactly the scopes their token grants', () => {
    const reader = mcpClientPrincipal('claude-code', ['read']);
    expect(hasScope(reader, 'propose')).toBe(false);
    expect(hasScope(mcpClientPrincipal('ops-bot', ['read', 'propose', 'approve']), 'approve')).toBe(true);
  });
});

describe('scope enforcement in the harness', () => {
  const proposeOne = async (env: ReturnType<typeof setup>) =>
    env.harness.propose({ ctx: env.ctx, principal: agent, ops: [{ action: 'purchases.upsert', input: poInput() }] });

  test('read-only principals cannot propose', async () => {
    const env = setup();
    const reader = mcpClientPrincipal('ro', ['read']);
    await expect(env.harness.propose({ ctx: env.ctx, principal: reader, ops: [{ action: 'purchases.upsert', input: poInput() }] })).rejects.toThrow(ForbiddenError);
  });

  test('agent cannot approve', async () => {
    const env = setup();
    const p = await proposeOne(env);
    const forged: Principal = { ...agent, scopes: ['read', 'propose', 'approve'] };
    for (const principal of [agent, forged]) {
      await expect(env.harness.decide({ ctx: env.ctx, principal, proposalId: p.id, decision: 'approve' })).rejects.toThrow(ForbiddenError);
    }
    expect((await env.harness.get(p.id)).status).toBe('pending_approval');
  });

  test('operator cannot approve', async () => {
    const env = setup();
    const p = await proposeOne(env);
    await expect(env.harness.decide({ ctx: env.ctx, principal: operator, proposalId: p.id, decision: 'approve' })).rejects.toThrow(ForbiddenError);
  });

  test('approver can approve', async () => {
    const env = setup();
    const p = await proposeOne(env);
    const decided = await env.harness.decide({ ctx: env.ctx, principal: approver, proposalId: p.id, decision: 'approve' });
    expect(decided.status).toBe('approved');
    expect(decided.decision?.by.id).toBe(approver.id);
  });

  test('separation of duties: an approver cannot decide their own proposal (configurable)', async () => {
    const env = setup();
    const own = await env.harness.propose({ ctx: env.ctx, principal: approver, ops: [{ action: 'purchases.upsert', input: poInput() }] });
    await expect(env.harness.decide({ ctx: env.ctx, principal: approver, proposalId: own.id, decision: 'approve' })).rejects.toThrow(ForbiddenError);
    expect((await env.harness.decide({ ctx: env.ctx, principal: approver2, proposalId: own.id, decision: 'approve' })).status).toBe('approved');

    const lax = setup({ config: { separationOfDuties: false } });
    const p = await lax.harness.propose({ ctx: lax.ctx, principal: approver, ops: [{ action: 'purchases.upsert', input: poInput() }] });
    expect((await lax.harness.decide({ ctx: lax.ctx, principal: approver, proposalId: p.id, decision: 'approve' })).status).toBe('approved');
  });

  test('deciding twice is a conflict, not a second decision', async () => {
    const env = setup();
    const p = await proposeOne(env);
    await env.harness.decide({ ctx: env.ctx, principal: approver, proposalId: p.id, decision: 'reject', reason: 'not now' });
    await expect(env.harness.decide({ ctx: env.ctx, principal: approver2, proposalId: p.id, decision: 'approve' })).rejects.toThrow(DecisionConflictError);
  });
});
