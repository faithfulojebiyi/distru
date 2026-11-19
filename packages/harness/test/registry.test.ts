import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineAction, ForbiddenError, InputValidationError, mcpClientPrincipal, NotFoundError, Registry, toolNameFor } from '../src';
import { agent, approver, type Ctx, inventoryReadTool, purchaseUpsertAction, setup } from './fixtures';

describe('Registry', () => {
  const registry = new Registry<Ctx>({ actions: [purchaseUpsertAction()], readTools: [inventoryReadTool] });

  test('lists actions and read tools, looks them up by name', () => {
    expect(registry.actions().map((a) => a.name)).toEqual(['purchases.upsert']);
    expect(registry.readTools().map((t) => t.name)).toEqual(['inventory.search']);
    expect(registry.action('purchases.upsert').requiredScope).toBe('propose');
    expect(() => registry.action('nope')).toThrow(NotFoundError);
  });

  test('catalog exposes JSON Schemas and propose_* tool names for adapters (Mastra / MCP)', () => {
    const catalog = registry.catalog();
    const action = catalog.find((t) => t.kind === 'action');
    expect(action).toMatchObject({ toolName: 'propose_purchases_upsert', resource: 'purchases', risk: 'low', requiredScope: 'propose' });
    expect(action?.inputSchema).toMatchObject({ type: 'object', required: ['vendorId', 'items'] });
    const read = catalog.find((t) => t.kind === 'read');
    expect(read).toMatchObject({ toolName: 'inventory_search', requiredScope: 'read' });
    expect(read?.kind === 'read' ? read.outputSchema : undefined).toMatchObject({ type: 'array' });
  });

  test('catalog can be filtered to what a principal may call', () => {
    const readOnly = mcpClientPrincipal('ro', ['read']);
    expect(registry.catalog(readOnly).map((t) => t.toolName)).toEqual(['inventory_search']);
    expect(registry.catalog(agent).map((t) => t.toolName)).toEqual(['inventory_search', 'propose_purchases_upsert']);
  });

  test('approve-gated actions are hidden from agents', () => {
    const dangerous = defineAction({
      ...purchaseUpsertAction('high'),
      name: 'purchases.void',
      requiredScope: 'approve',
    });
    const r = new Registry<Ctx>({ actions: [dangerous] });
    expect(r.catalog(agent)).toEqual([]);
    expect(r.catalog(approver).map((t) => t.toolName)).toEqual(['propose_purchases_void']);
  });

  test('rejects duplicate and malformed names', () => {
    expect(() => new Registry<Ctx>({ actions: [purchaseUpsertAction(), purchaseUpsertAction()] })).toThrow('Duplicate');
    expect(() => defineAction({ ...purchaseUpsertAction(), name: 'Bad Name' })).toThrow('Invalid action');
    expect(toolNameFor('action', 'a.b.c')).toBe('propose_a_b_c');
  });

  test('runReadTool enforces read scope and validates input/output', async () => {
    const env = setup();
    expect(await registry.runReadTool(env.ctx, agent, 'inventory.search', { query: 'blue' })).toEqual([{ sku: 'BLUE', quantity: 3 }]);
    await expect(registry.runReadTool(env.ctx, agent, 'inventory.search', { query: '' })).rejects.toThrow(InputValidationError);
    const noScopes = mcpClientPrincipal('none', []);
    await expect(registry.runReadTool(env.ctx, noScopes, 'inventory.search', { query: 'x' })).rejects.toThrow(ForbiddenError);
  });

  test('a proposal requiring the approve scope cannot be created by an agent', async () => {
    const env = setup();
    env.registry.addAction(defineAction({ ...purchaseUpsertAction('high'), name: 'purchases.void', requiredScope: 'approve' }));
    await expect(
      env.harness.propose({ ctx: env.ctx, principal: agent, ops: [{ action: 'purchases.void', input: { vendorId: 'v', items: [{ productId: 'a', quantity: 1, unitPrice: 1 }] } }] }),
    ).rejects.toThrow(ForbiddenError);
  });

  test('input validation errors carry zod issues', async () => {
    const env = setup();
    try {
      await env.harness.propose({ ctx: env.ctx, principal: agent, ops: [{ action: 'purchases.upsert', input: { vendorId: 3 } }] });
      throw new Error('expected failure');
    } catch (err) {
      expect(err).toBeInstanceOf(InputValidationError);
      expect(err instanceof InputValidationError ? err.issues.map((i) => i.path.join('.')) : []).toEqual(['vendorId', 'items']);
    }
    expect(z.string().safeParse('ok').success).toBe(true);
  });
});
