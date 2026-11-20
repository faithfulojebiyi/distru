import { describe, expect, test } from 'bun:test';
import {
  assertScope,
  DecisionConflictError,
  ForbiddenError,
  hasScope,
  humanOf,
  isExecutable,
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

  test('separation of duties sees through tokens: an approver cannot decide what their own MCP token proposed', async () => {
    const env = setup();
    // The approver mints a propose+approve token, proposes through it, then tries to approve as themself.
    const token = mcpClientPrincipal('tok-1', ['read', 'propose', 'approve'], 'MCP token: mine', approver.id);
    expect(humanOf(token)).toBe(approver.id);
    const viaToken = await env.harness.propose({ ctx: env.ctx, principal: token, ops: [{ action: 'purchases.upsert', input: poInput() }] });
    expect(viaToken.createdBy.onBehalfOf).toBe(approver.id);
    await expect(env.harness.decide({ ctx: env.ctx, principal: approver, proposalId: viaToken.id, decision: 'approve' })).rejects.toThrow(/Separation of duties/);
    // A second token of the same approver is the same human too.
    const other = mcpClientPrincipal('tok-2', ['read', 'approve'], 'MCP token: other', approver.id);
    await expect(env.harness.decide({ ctx: env.ctx, principal: other, proposalId: viaToken.id, decision: 'approve' })).rejects.toThrow(ForbiddenError);
    // Another approver may decide it.
    expect((await env.harness.decide({ ctx: env.ctx, principal: approver2, proposalId: viaToken.id, decision: 'approve' })).status).toBe('approved');
  });

  test('separation of duties the other way: a token cannot decide what the human behind it proposed', async () => {
    const env = setup();
    const own = await env.harness.propose({ ctx: env.ctx, principal: approver, ops: [{ action: 'purchases.upsert', input: poInput() }] });
    const token = mcpClientPrincipal('tok-1', ['read', 'approve'], undefined, approver.id);
    await expect(env.harness.decide({ ctx: env.ctx, principal: token, proposalId: own.id, decision: 'reject' })).rejects.toThrow(ForbiddenError);
    expect((await env.harness.get(own.id)).status).toBe('pending_approval');
  });

  test('principals without a human behind them never match each other by human', async () => {
    const env = setup();
    const p = await proposeOne(env);
    const legacyToken = mcpClientPrincipal('tok-legacy', ['read', 'approve']);
    expect(humanOf(agent)).toBeNull();
    expect(humanOf(legacyToken)).toBeNull();
    expect((await env.harness.decide({ ctx: env.ctx, principal: legacyToken, proposalId: p.id, decision: 'approve' })).status).toBe('approved');
  });

  test('isExecutable: only approved, auto-approved or a retried execution', () => {
    expect(isExecutable({ status: 'approved' })).toBe(true);
    expect(isExecutable({ status: 'auto_approved' })).toBe(true);
    expect(isExecutable({ status: 'executing' })).toBe(true);
    for (const status of ['pending_approval', 'rejected', 'denied', 'failed', 'executed', 'draft'] as const) expect(isExecutable({ status })).toBe(false);
  });

  test('deciding twice is a conflict, not a second decision', async () => {
    const env = setup();
    const p = await proposeOne(env);
    await env.harness.decide({ ctx: env.ctx, principal: approver, proposalId: p.id, decision: 'reject', reason: 'not now' });
    await expect(env.harness.decide({ ctx: env.ctx, principal: approver2, proposalId: p.id, decision: 'approve' })).rejects.toThrow(DecisionConflictError);
  });
});
