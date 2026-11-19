/**
 * The cross-tool half of the restock workflow, all deterministic code (no model decides any of it):
 *
 * - **Allocation guard**: for each at-risk SKU whose COMPANY-WIDE retail-adjusted days of supply are
 *   below the vendor lead time (it will stock out before the PO can arrive), a per-buyer cap on Distru
 *   Commerce menu orders (`maxMenuBuyerOrderQuantity`, via the Distru MCP bridge
 *   `distru_mcp.mutate_product`): company-wide available ÷ active buyers in the last 14 days, rounded
 *   down to whole cases, at least one case. The cap is a product-level (company-wide) setting, so both
 *   inputs are company-wide: available from `products_get`, days of supply from the velocity report
 *   without a location filter, blended with retail by `headset.demand_signal`. Passed to the Planner as a suggestion; checked by the plan guard; backfilled if omitted.
 * - **Assembly**: the one proposal is ordered per PO as
 *     PO → buyer cap(s) for that PO's SKUs → vendor email → receiving task
 *   The email and the task reference the PO with op references (`{{op:<i>.purchase_number}}`,
 *   `{{op:<i>.recordId}}`) that the harness resolves at execute time from the PO op's result (the PO
 *   number only exists after the PO is written). The diff shows the placeholder; the op result records
 *   the resolved value.
 */
import { unprefixId } from '@ops/connector-mcp';
import { opRef, type OpRequest, type Registry } from '@ops/harness';
import { z } from 'zod';
import { previewOp } from '../../harness/dry-run';
import type { AppCtx } from '../../harness/registry';
import type { AtRiskSku } from '../agents/inventory-analyst';
import type { GuardSuggestion } from '../agents/procurement-planner';
import { principalFor } from '../agents/roster';
import { draftOpFrom, type DraftOp } from '../tools/run-context';
import { VelocityRowSchema, type VelocityRow } from '@ops/connector-distru';
import { demandSignalFor } from './demand';

export const PURCHASE_ACTION = 'distru.purchases.upsert';
export const CAP_ACTION = 'distru_mcp.mutate_product';
export const EMAIL_ACTION = 'email.send_vendor_po';
export const TASK_ACTION = 'distru.tasks.create';

/** Look-back for "active buyers" of a SKU. */
export const ACTIVE_BUYER_DAYS = 14;

export interface CrossToolOptions {
  /** Add an `email.send_vendor_po` op after each PO (default true; needs the email connector). */
  vendorEmails?: boolean;
  /** Add a `distru.tasks.create` hand-off task after each PO (default true). */
  receivingTasks?: boolean;
  /** Compute per-buyer caps for SKUs that stock out before their PO arrives (default true; needs distru_mcp). */
  allocationGuard?: boolean;
  /** Distru role whose user receives the "Receive PO-… on <date>" task. */
  taskOwnerRole?: string;
  /** Signature line of the vendor email. */
  signature?: string;
}

const analyst = principalFor('inventoryAnalyst');
const planner = principalFor('procurementPlanner');

export const hasAction = (registry: Registry<AppCtx>, name: string) => registry.actions().some((a) => a.name === name);
const hasReadTool = (registry: Registry<AppCtx>, name: string) => registry.readTools().some((t) => t.name === name);
const sameProduct = (a: string, b: string) => unprefixId(a) === unprefixId(b);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);
const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ── op inspection ────────────────────────────────────────────────────────────────────────────

const PurchaseInput = z.object({
  vendor_id: z.string(),
  location_id: z.string(),
  lines: z.array(z.object({ product_id: z.string(), quantity: z.number(), unit_price: z.number() })),
});
export type PurchaseLike = z.infer<typeof PurchaseInput>;

export function purchaseOf(op: Pick<DraftOp, 'action' | 'input'>): PurchaseLike | null {
  if (op.action !== PURCHASE_ACTION) return null;
  const parsed = PurchaseInput.safeParse(op.input);
  return parsed.success ? parsed.data : null;
}

const CapInput = z.object({ action: z.string(), id: z.string(), maxMenuBuyerOrderQuantity: z.number().nullable().optional() }).passthrough();
/** Keys a guard cap op may carry (the cap itself, and fields the bridge fills from run context). */
const CAP_KEYS = new Set(['action', 'id', 'maxMenuBuyerOrderQuantity', 'intent', 'userSatisfactionEstimate', 'account']);

export interface CapLike {
  productId: string;
  cap: number | null | undefined;
  action: string;
  extraKeys: string[];
}

export function capOf(op: Pick<DraftOp, 'action' | 'input'>): CapLike | null {
  if (op.action !== CAP_ACTION) return null;
  const parsed = CapInput.safeParse(op.input);
  if (!parsed.success) return null;
  return { productId: parsed.data.id, cap: parsed.data.maxMenuBuyerOrderQuantity, action: parsed.data.action, extraKeys: Object.keys(parsed.data).filter((k) => !CAP_KEYS.has(k)) };
}

/** A draft op belongs to a vendor's Planner when it is that vendor's PO, or a cap on one of that vendor's SKUs. */
export function opBelongsTo(op: DraftOp, vendorId: string, productIds: readonly string[]): boolean {
  const po = purchaseOf(op);
  if (po) return po.vendor_id === vendorId;
  const cap = capOf(op);
  if (cap) return productIds.some((p) => sameProduct(p, cap.productId));
  return false;
}

/** Caps only make sense next to a PO for the same SKU ("stock out before the PO arrives"). */
export function pruneCaps(ops: readonly DraftOp[]): DraftOp[] {
  const ordered = new Set(ops.flatMap((op) => purchaseOf(op)?.lines.map((l) => unprefixId(l.product_id)) ?? []));
  return ops.filter((op) => {
    const cap = capOf(op);
    return !cap || ordered.has(unprefixId(cap.productId));
  });
}

/** Plan guard for cap ops: exactly the computed suggestion, UPDATE, nothing but the cap. */
export function capFindings(ops: readonly DraftOp[], guard: readonly GuardSuggestion[]): string[] {
  const out: string[] = [];
  for (const op of ops) {
    const cap = capOf(op);
    if (op.action === CAP_ACTION && !cap) {
      out.push('A distru_mcp.mutate_product op has no readable product id / cap; only allocation-guard caps may be proposed');
      continue;
    }
    if (!cap) continue;
    const g = guard.find((s) => sameProduct(s.product_id, cap.productId));
    if (!g) out.push(`Product ${cap.productId}: no allocation-guard suggestion for it; only computed caps may be proposed (remove it)`);
    else if (cap.action !== 'UPDATE' || cap.cap !== g.cap) out.push(`${g.sku}: the cap must be the computed one (UPDATE maxMenuBuyerOrderQuantity=${g.cap}), got ${cap.action} ${String(cap.cap)}`);
    if (cap.extraKeys.length) out.push(`${g?.sku ?? cap.productId}: only maxMenuBuyerOrderQuantity may be changed (also got ${cap.extraKeys.join(', ')})`);
  }
  return out;
}

// ── allocation guard ─────────────────────────────────────────────────────────────────────────

const ProductDetail = z.object({ quantity_available: z.number(), units_per_case: z.number().nullable() });
const McpProduct = z.object({ product: z.object({ maxMenuBuyerOrderQuantity: z.number().nullable().optional() }).passthrough().nullable() });

export interface GuardContext {
  registry: Registry<AppCtx>;
  ctx: AppCtx;
  now: Date;
}

const CompanyVelocity = z.object({ rows: z.array(VelocityRowSchema) });

/**
 * Company-wide, retail-adjusted days of supply. The buyer cap is a company-wide setting (one Distru
 * Commerce menu, every location's stock), so its trigger uses the company-wide velocity row (no
 * location filter: all locations combined) blended with retail by the same code the scan uses
 * (`headset.demand_signal`), never a single location's row or model output. Falls back to the
 * location row when the company-wide report has no row for the product.
 */
export async function companyDaysOfSupply(g: GuardContext, item: AtRiskSku, leadTime: number): Promise<{ adjusted: number | null; wholesale: number | null }> {
  let row: Pick<VelocityRow, 'sku' | 'days_of_supply' | 'avg_daily_demand'> = { sku: item.sku, days_of_supply: item.days_of_supply, avg_daily_demand: item.avg_daily_demand };
  try {
    // `'any'`: the company-wide row whether or not it is below its reorder point.
    for (const below of ['any' as const]) {
      const out = CompanyVelocity.parse(
        await g.registry.runReadTool(g.ctx, analyst, 'distru.velocity_report', { below_reorder_point: below, product_ids: [item.product_id], lead_time_days: leadTime, limit: 5 }),
      );
      const company = out.rows.find((r) => r.product_id === item.product_id);
      if (company) {
        row = company;
        break;
      }
    }
  } catch {
    /* keep the location row */
  }
  const signal = await demandSignalFor(g.registry, g.ctx, row, leadTime);
  return { adjusted: signal?.adjusted_days_of_supply ?? row.days_of_supply, wholesale: row.days_of_supply };
}

/** Distinct customers with a (non-cancelled) order containing the product in the last `ACTIVE_BUYER_DAYS` days. */
export async function activeBuyers(ctx: AppCtx, productId: string, now: Date): Promise<number> {
  const client = ctx.connectors.distru;
  const since = addDays(now, -ACTIVE_BUYER_DAYS).toISOString();
  const orders = await client.listAll(client.listOrders, { order_datetime: `${since},`, product_ids: [productId] });
  return new Set(orders.filter((o) => o.status !== 'CANCELED' && o.company?.id).map((o) => o.company!.id)).size;
}

/** Cap = available ÷ buyers, rounded down to whole cases, at least one case. */
export function computeCap(available: number, buyers: number, unitsPerCase: number | null): number {
  const caseSize = unitsPerCase && unitsPerCase > 0 ? Math.round(unitsPerCase) : 1;
  const share = Math.floor(Math.max(0, available) / Math.max(1, buyers));
  return Math.max(caseSize, Math.floor(share / caseSize) * caseSize);
}

/**
 * Guard suggestions for one vendor's at-risk SKUs. Empty (with a note) when the MCP bridge is not
 * registered. A SKU already capped at or below the computed cap is left alone.
 */
export async function computeGuard(
  g: GuardContext,
  vendor: { id: string; name: string; lead_time_days: number | null },
  items: readonly AtRiskSku[],
): Promise<{ guard: GuardSuggestion[]; note: string | null }> {
  if (!hasAction(g.registry, CAP_ACTION)) return { guard: [], note: 'Distru MCP (distru_mcp) unavailable: allocation-guard caps were not computed' };
  const leadTime = vendor.lead_time_days ?? 14;
  const worst = new Map<string, { item: AtRiskSku; adjusted: number }>();
  for (const item of items) {
    const { adjusted } = await companyDaysOfSupply(g, item, leadTime);
    if (adjusted === null || adjusted >= leadTime) continue;
    const prev = worst.get(item.product_id);
    if (!prev || adjusted < prev.adjusted) worst.set(item.product_id, { item, adjusted });
  }
  const guard: GuardSuggestion[] = [];
  for (const [productId, { item, adjusted }] of worst) {
    const detail = ProductDetail.parse(await g.registry.runReadTool(g.ctx, planner, 'distru.products_get', { product_id: productId }));
    const buyers = await activeBuyers(g.ctx, productId, g.now);
    if (buyers === 0) continue; // nobody is ordering it: nothing to share
    const unitsPerCase = detail.units_per_case ?? item.units_per_case;
    const cap = computeCap(detail.quantity_available, buyers, unitsPerCase);
    let current: number | null = null;
    if (hasReadTool(g.registry, 'distru_mcp.get_product')) {
      const p = McpProduct.safeParse(await g.registry.runReadTool(g.ctx, planner, 'distru_mcp.get_product', { id: productId }));
      current = p.success ? (p.data.product?.maxMenuBuyerOrderQuantity ?? null) : null;
    }
    if (current !== null && current <= cap) continue; // already at least as tight
    guard.push({
      product_id: productId,
      sku: item.sku,
      name: item.name,
      cap,
      current_cap: current,
      available: detail.quantity_available,
      active_buyers: buyers,
      units_per_case: unitsPerCase,
      adjusted_days_of_supply: Math.round(adjusted * 10) / 10,
      lead_time_days: leadTime,
      reason: `${item.sku}: ${Math.round(adjusted * 10) / 10} company-wide adjusted days of supply < ${leadTime}-day lead time from ${vendor.name}; ${detail.quantity_available} available company-wide ÷ ${buyers} active buyer(s) (last ${ACTIVE_BUYER_DAYS} days) → ${cap} units per buyer order${unitsPerCase ? ` (whole cases of ${unitsPerCase})` : ''}`,
    });
  }
  return { guard, note: null };
}

// ── assembly ─────────────────────────────────────────────────────────────────────────────────

export interface VendorInfo {
  id: string;
  name: string;
  lead_time_days: number | null;
  purchase_order_email: string | null;
}

export interface AssembleArgs {
  registry: Registry<AppCtx>;
  ctx: AppCtx;
  ops: readonly DraftOp[];
  vendors: readonly VendorInfo[];
  atRisk: readonly AtRiskSku[];
  guard: readonly GuardSuggestion[];
  now: Date;
  runId: string;
  options: CrossToolOptions;
}

export interface AssembledOp extends OpRequest {
  /** Index of the PO op this op belongs to (null for the PO itself). */
  forPo: number | null;
  source: 'planner' | 'guard-backfill' | 'workflow';
}

export interface Assembled {
  ops: AssembledOp[];
  notes: string[];
  backfilledCaps: string[];
}

function emailBody(vendor: VendorInfo, po: PurchaseLike, index: number, atRisk: readonly AtRiskSku[], receiveOn: string, signature: string): string {
  const meta = (pid: string) => atRisk.find((a) => a.product_id === pid);
  const location = atRisk.find((a) => a.location_id === po.location_id)?.location_name ?? 'our warehouse';
  const total = po.lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);
  return [
    `Hello ${vendor.name} team,`,
    `Please find our purchase order **${opRef(index, 'purchase_number')}** for delivery to ${location}:`,
    po.lines.map((l) => `- ${meta(l.product_id)?.sku ?? l.product_id} ${meta(l.product_id)?.name ?? ''}: ${l.quantity.toLocaleString('en-US')} units @ ${money(l.unit_price)}`.replace(/\s+:/, ':')).join('\n'),
    `Order total: ${money(total)}. We plan to receive it on ${receiveOn}; please confirm the order and your ship date.`,
    `Reference: Distru purchase ${opRef(index, 'recordId')}.`,
    `Thank you,\n${signature}`,
  ].join('\n\n');
}

/**
 * Orders the final proposal: PO → its caps → vendor email → receiving task, per PO, and adds the
 * cross-tool ops (validated through `previewOp`, so a bad op fails here rather than at propose).
 */
export async function assembleProposal(a: AssembleArgs): Promise<Assembled> {
  const notes: string[] = [];
  const backfilledCaps: string[] = [];
  const emails = a.options.vendorEmails !== false && hasAction(a.registry, EMAIL_ACTION);
  const tasks = a.options.receivingTasks !== false && hasAction(a.registry, TASK_ACTION);
  if (a.options.vendorEmails !== false && !emails) notes.push('Email connector unavailable: no vendor emails added');
  if (a.options.receivingTasks !== false && !tasks) notes.push('Distru tasks unavailable: no receiving tasks added');

  const pos = a.ops.filter((op) => purchaseOf(op));
  const caps = pruneCaps(a.ops).filter((op) => capOf(op));
  const capFor = new Map<string, DraftOp>(caps.map((op) => [unprefixId(capOf(op)!.productId), op]));
  // Backfill: a computed cap the Planner did not propose, for a SKU that is on a PO.
  if (hasAction(a.registry, CAP_ACTION)) {
    const ordered = new Set(pos.flatMap((op) => purchaseOf(op)!.lines.map((l) => unprefixId(l.product_id))));
    for (const g of a.guard) {
      const key = unprefixId(g.product_id);
      if (!ordered.has(key) || capFor.has(key)) continue;
      const preview = await previewOp(a.registry, a.ctx, planner, { action: CAP_ACTION, input: { action: 'UPDATE', id: g.product_id, maxMenuBuyerOrderQuantity: g.cap } });
      capFor.set(key, draftOpFrom(preview));
      backfilledCaps.push(g.sku);
    }
  }
  const backfilledKeys = new Set(a.guard.filter((g) => backfilledCaps.includes(g.sku)).map((g) => unprefixId(g.product_id)));

  const out: AssembledOp[] = [];
  const placedCaps = new Set<string>();
  for (const poOp of pos) {
    const po = purchaseOf(poOp)!;
    const poIndex = out.length;
    out.push({ action: poOp.action, input: poOp.input, forPo: null, source: 'planner' });
    for (const line of po.lines) {
      const key = unprefixId(line.product_id);
      const cap = capFor.get(key);
      if (!cap || placedCaps.has(key)) continue;
      placedCaps.add(key);
      out.push({ action: cap.action, input: cap.input, forPo: poIndex, source: backfilledKeys.has(key) ? 'guard-backfill' : 'planner' });
    }
    const vendor = a.vendors.find((v) => v.id === po.vendor_id) ?? { id: po.vendor_id, name: po.vendor_id, lead_time_days: null, purchase_order_email: null };
    const receiveOn = isoDay(addDays(a.now, vendor.lead_time_days ?? 14));
    if (emails) {
      if (!vendor.purchase_order_email) notes.push(`${vendor.name}: no purchase-order email on file, vendor email skipped`);
      else {
        const input = {
          to: vendor.purchase_order_email,
          vendor_name: vendor.name,
          po_number: opRef(poIndex, 'purchase_number'),
          purchase_id: opRef(poIndex, 'recordId'),
          body_markdown: emailBody(vendor, po, poIndex, a.atRisk, receiveOn, a.options.signature ?? 'Purchasing, Golden Coast Distro'),
        };
        await previewOp(a.registry, a.ctx, planner, { action: EMAIL_ACTION, input });
        out.push({ action: EMAIL_ACTION, input, forPo: poIndex, source: 'workflow' });
      }
    }
    if (tasks) {
      const units = po.lines.reduce((s, l) => s + l.quantity, 0);
      const location = a.atRisk.find((r) => r.location_id === po.location_id)?.location_name ?? 'the receiving location';
      const input = {
        name: `Receive ${opRef(poIndex, 'purchase_number')} on ${receiveOn}`,
        due: receiveOn,
        owner_role: a.options.taskOwnerRole ?? 'Purchasing Manager',
        purchase_id: opRef(poIndex, 'recordId'),
        description: `Receive ${vendor.name} purchase order ${opRef(poIndex, 'purchase_number')} at ${location}: ${po.lines.length} line(s), ${units.toLocaleString('en-US')} units. Check quantities and lab results against the PO. Created by Ops Agent restock run ${a.runId}.`,
      };
      await previewOp(a.registry, a.ctx, planner, { action: TASK_ACTION, input });
      out.push({ action: TASK_ACTION, input, forPo: poIndex, source: 'workflow' });
    }
  }
  return { ops: out, notes, backfilledCaps };
}
