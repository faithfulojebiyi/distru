import { defineAction, matchesExpected, Registry, type Risk } from '@ops/harness';
import { z } from 'zod';

/**
 * A tiny in-memory ERP with Distru-like sparse upsert semantics, plus a `purchases.upsert` action
 * over it. Mirrors packages/harness/test/fixtures.ts so app-level tests don't need distru-mock.
 */
export interface Purchase {
  id: string;
  vendorId: string;
  externalRef: string | null;
  items: Array<{ productId: string; quantity: number; unitPrice: number }>;
}

export class FakeErp {
  readonly purchases = new Map<string, Purchase>();
  writes = 0;
  #nextId = 100;

  get(id: string): Purchase | null {
    const p = this.purchases.get(id);
    return p ? structuredClone(p) : null;
  }

  findByRef(ref: string): Purchase | null {
    for (const p of this.purchases.values()) if (p.externalRef === ref) return structuredClone(p);
    return null;
  }

  upsert(payload: PurchasePayload, externalRef: string): Purchase {
    this.writes++;
    const record: Purchase = { id: `po-${this.#nextId++}`, vendorId: payload.vendorId, externalRef, items: payload.items };
    this.purchases.set(record.id, record);
    return structuredClone(record);
  }
}

export const FAKE_PURCHASE_ACTION = 'distru.purchases.upsert';

export interface TestCtx {
  erp: FakeErp;
}

const PurchaseInput = z.object({
  vendorId: z.string(),
  items: z.array(z.object({ productId: z.string(), quantity: z.number().int().positive(), unitPrice: z.number().nonnegative() })).min(1),
});
type PurchasePayload = z.infer<typeof PurchaseInput>;

export function purchaseUpsertAction(risk: Risk = 'medium') {
  return defineAction({
    // Same registry name as the Distru connector's action, so the seeded `allowed_actions` rule applies.
    name: FAKE_PURCHASE_ACTION,
    resource: 'purchases',
    description: 'Create a purchase order (fake ERP).',
    risk,
    input: PurchaseInput,
    payload: PurchaseInput,
    loadBefore: async () => null,
    plan: (_ctx: TestCtx, input): PurchasePayload => input,
    execute: async (ctx: TestCtx, payload, key) => {
      const record = ctx.erp.upsert(payload, key);
      return { recordId: record.id, record };
    },
    verify: async (ctx: TestCtx, recordId, expected) => matchesExpected(ctx.erp.get(recordId), expected),
    findByIdempotencyKey: async (ctx: TestCtx, key) => {
      const record = ctx.erp.findByRef(key);
      return record ? { recordId: record.id, record } : null;
    },
    valueOf: (payload) => payload.items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0),
    vendorIdsOf: (payload) => [payload.vendorId],
    summarize: (input) => `PO for ${input.items.length} line(s) from ${input.vendorId}`,
  });
}

export const testRegistry = () => new Registry<TestCtx>({ actions: [purchaseUpsertAction()] });

export const poInput = (quantity = 10, unitPrice = 120) => ({
  vendorId: 'v-acme',
  items: [{ productId: 'sku-blue-dream', quantity, unitPrice }],
});
