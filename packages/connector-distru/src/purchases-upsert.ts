/**
 * `purchases.upsert` (registry name `distru.purchases.upsert`, tool `propose_distru_purchases_upsert`).
 *
 * Distru semantics: POST /purchases without `id` creates, with `id` updates sparsely; sending
 * `items` replaces the whole line set (lines whose id is omitted are deleted). Distru has no
 * idempotency header, so the harness key is stamped into the PO description as
 * `[ops-agent:idem=<key>]` and looked up before every write attempt.
 */
import {
  buildPurchaseOrder,
  buildPurchaseUpdate,
  DistruApiError,
  findPurchaseByIdempotencyKey,
  idempotencyMarker,
  type Purchase,
  type PurchaseItemRequest,
  type UpsertPurchaseBody,
} from '@ops/distru-client';
import { defineAction, InputValidationError, matchesExpected } from '@ops/harness';
import { z } from 'zod';
import { money, must, num0, type DistruCtx } from './shared';
import { stripIdempotencyMarkers } from './tools/orders';

export const PurchaseLineInputSchema = z.object({
  product_id: z.string().min(1),
  quantity: z.number().positive().max(1_000_000),
  unit_price: z.number().nonnegative().max(1_000_000).describe('Price per unit in company currency'),
});

export const PurchaseUpsertInputSchema = z
  .object({
    vendor_id: z.string().min(1).describe('Distru company id of the vendor'),
    location_id: z.string().min(1).describe('Receiving location (one of your locations)'),
    lines: z.array(PurchaseLineInputSchema).min(1).max(100).describe('Complete desired line set (on update, omitted products are removed)'),
    expected_delivery_date: z.iso.date().optional().describe('YYYY-MM-DD; recorded in the PO notes (Distru has no delivery-date field on purchases)'),
    notes: z.string().trim().max(500).optional().describe('Human-readable PO notes'),
    purchase_id: z.string().min(1).optional().describe('Update this existing purchase order instead of creating one'),
  })
  .refine((v) => new Set(v.lines.map((l) => l.product_id)).size === v.lines.length, {
    message: 'Each product may appear in only one line',
    path: ['lines'],
  });
export type PurchaseUpsertInput = z.infer<typeof PurchaseUpsertInputSchema>;

/** A Distru purchase normalized to the request-body shape, so the harness diff/verify are field-to-field. */
export interface PurchaseRecord {
  id: string;
  purchase_number: string;
  status: string;
  company_id: string | null;
  vendor_name: string | null;
  location_id: string | null;
  billing_location_id: string | null;
  /** Description without idempotency markers. */
  description: string | null;
  items: Array<{ id: string; product_id: string | null; location_id: string | null; quantity: number; price: number }>;
  total: number;
}

export function normalizePurchase(p: Purchase): PurchaseRecord {
  return {
    id: p.id,
    purchase_number: p.purchase_number,
    status: p.status,
    company_id: p.company?.id ?? null,
    vendor_name: p.company?.name ?? null,
    location_id: p.location?.id ?? null,
    billing_location_id: p.billing_location?.id ?? null,
    description: stripIdempotencyMarkers(p.description),
    items: p.items.map((i) => ({
      id: i.id,
      product_id: i.product?.id ?? null,
      location_id: i.location?.id ?? null,
      quantity: num0(i.quantity),
      price: num0(i.price),
    })),
    total: num0(p.total),
  };
}

const EDITABLE_STATUSES = new Set(['DRAFT', 'PENDING', 'PROCESSING']);

function notesFor(input: PurchaseUpsertInput): string | undefined {
  const parts = [input.notes, input.expected_delivery_date ? `Expected delivery: ${input.expected_delivery_date}` : undefined].filter(
    (s): s is string => Boolean(s),
  );
  return parts.length ? parts.join('\n') : undefined;
}

/** Appends the idempotency marker to a description (once). */
export function stampDescription(description: string | null | undefined, key: string): string {
  const marker = idempotencyMarker(key);
  if (description?.includes(marker)) return description;
  return description ? `${description}\n${marker}` : marker;
}

const itemsValue = (items: readonly PurchaseItemRequest[] | null | undefined): number =>
  Math.round((items ?? []).reduce((sum, i) => sum + Number(i.quantity) * Number(i.price), 0) * 100) / 100;
const itemsUnits = (items: readonly PurchaseItemRequest[] | null | undefined): number =>
  (items ?? []).reduce((sum, i) => sum + Number(i.quantity), 0);

/** The fields of a body that a read-back must reproduce (timestamps are server-normalized, so skipped). */
function expectedShape(body: UpsertPurchaseBody): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ['status', 'company_id', 'location_id', 'billing_location_id', 'description'] as const) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  if (body.items) {
    out.items = body.items.map((i) => ({
      ...(i.id ? { id: i.id } : {}),
      ...(i.product_id ? { product_id: i.product_id } : {}),
      ...(i.location_id ? { location_id: i.location_id } : {}),
      quantity: i.quantity,
      price: i.price,
    }));
  }
  return out;
}

async function getPurchaseOrNull(ctx: DistruCtx, id: string): Promise<Purchase | null> {
  try {
    return (await ctx.connectors.distru.getPurchase(id)).data ?? null;
  } catch (err) {
    if (err instanceof DistruApiError && err.isNotFound) return null;
    throw err;
  }
}

export const purchasesUpsertAction = defineAction({
  name: 'purchases.upsert',
  resource: 'purchases',
  risk: 'medium',
  requiredScope: 'propose',
  description:
    'Propose creating (or, with purchase_id, updating) a Distru purchase order for one vendor and receiving location. Nothing is written until a human approves; `lines` is the complete desired line set.',
  input: PurchaseUpsertInputSchema,

  loadBefore: async (ctx: DistruCtx, input): Promise<PurchaseRecord | null> => {
    if (!input.purchase_id) return null;
    const po = await getPurchaseOrNull(ctx, input.purchase_id);
    if (!po) throw new InputValidationError(`Purchase order ${input.purchase_id} not found`);
    return normalizePurchase(po);
  },

  plan: (_ctx: DistruCtx, input, before): UpsertPurchaseBody => {
    const description = notesFor(input);
    if (!before) {
      return buildPurchaseOrder({
        vendorId: input.vendor_id,
        locationId: input.location_id,
        lines: input.lines.map((l) => ({ productId: l.product_id, quantity: l.quantity, unitPrice: l.unit_price })),
        status: 'PENDING',
        ...(description ? { description } : {}),
      });
    }
    if (!EDITABLE_STATUSES.has(before.status)) {
      throw new InputValidationError(`Purchase order ${before.purchase_number} is ${before.status} and can no longer be edited`);
    }
    if (before.company_id && before.company_id !== input.vendor_id) {
      throw new InputValidationError(`Purchase order ${before.purchase_number} belongs to another vendor; create a new PO instead`);
    }
    if (before.location_id && before.location_id !== input.location_id) {
      throw new InputValidationError(`Purchase order ${before.purchase_number} receives at another location (location cannot change)`);
    }
    // Keep existing line ids for products still wanted (so Distru updates rather than re-creates them).
    const existing = new Map(before.items.filter((i) => i.product_id).map((i) => [i.product_id, i.id]));
    const items: PurchaseItemRequest[] = input.lines.map((l) => {
      const id = existing.get(l.product_id);
      return { ...(id ? { id } : {}), product_id: l.product_id, location_id: input.location_id, quantity: l.quantity, price: l.unit_price };
    });
    return buildPurchaseUpdate(before.id, {
      company_id: input.vendor_id,
      location_id: input.location_id,
      ...(description !== undefined ? { description } : {}),
      items,
    });
  },

  execute: async (ctx: DistruCtx, payload, idempotencyKey) => {
    const client = ctx.connectors.distru;
    let base = payload.description;
    if (payload.id && base === undefined) base = must((await client.getPurchase(payload.id)).data, `purchase ${payload.id}`).description;
    const body: UpsertPurchaseBody = { ...payload, description: stampDescription(base, idempotencyKey) };
    const po = must((await client.upsertPurchase(body)).data, 'upsertPurchase');
    return { recordId: po.id, record: normalizePurchase(po) };
  },

  findByIdempotencyKey: async (ctx: DistruCtx, idempotencyKey) => {
    const po = await findPurchaseByIdempotencyKey(ctx.connectors.distru, idempotencyKey);
    return po ? { recordId: po.id, record: normalizePurchase(po) } : null;
  },

  verify: async (ctx: DistruCtx, recordId, expected) => {
    const po = must((await ctx.connectors.distru.getPurchase(recordId)).data, `purchase ${recordId}`);
    return matchesExpected(normalizePurchase(po), expectedShape(expected));
  },

  valueOf: (payload) => itemsValue(payload.items),
  /** Later ops may reference `{{op:N.purchase_number}}` (vendor email, receiving task). */
  outputs: (record) => ({ purchase_number: record.purchase_number, status: record.status }),
  vendorIdsOf: (payload) => (payload.company_id ? [payload.company_id] : []),

  summarize: async (input, payload, ctx: DistruCtx, before) => {
    let vendor = before?.vendor_name ?? null;
    if (!vendor) {
      try {
        vendor = (await ctx.connectors.distru.getCompany(input.vendor_id)).data?.name ?? input.vendor_id;
      } catch {
        vendor = input.vendor_id;
      }
    }
    const n = payload.items?.length ?? 0;
    const units = itemsUnits(payload.items);
    const what = `${n} line${n === 1 ? '' : 's'}, ${units.toLocaleString('en-US')} units, ${money(itemsValue(payload.items))}`;
    return before ? `Update ${before.purchase_number} (${vendor}): ${what}` : `PO to ${vendor}: ${what}`;
  },
});
