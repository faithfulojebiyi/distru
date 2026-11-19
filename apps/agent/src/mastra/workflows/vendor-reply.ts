import { createStep, createWorkflow as createDefaultWorkflow } from '@mastra/core/workflows';
import { GmailNewMessageEventSchema, type GmailNewMessageEvent } from '@ops/connector-composio';
import { normalizePurchase } from '@ops/connector-distru';
import { ProposalStatusSchema, totalValue, type Harness, type OpRequest, type Proposal, type Registry } from '@ops/harness';
import { z } from 'zod';
import { previewOp } from '../../harness/dry-run';
import type { AppCtx } from '../../harness/registry';
import type { ProposalNotifier } from '../../slack/approvals';
import { principalFor } from '../agents/roster';
import { vendorLiaisonPrompt, VendorReplyAnalysisSchema, type VendorReplyAnalysis } from '../agents/vendor-liaison';
import { inngestWorkflowKit } from '../inngest';
import { AWAIT_DECISION_STEP, RestockResumeSchema, VENDOR_REPLY_WORKFLOW_ID } from '../restock-launcher';
import { AgentTraceEntrySchema, type Pricing } from '../trace';
import { chooseHeadline, untrustedTextsIn, vendorReplyTemplateTitle } from '../../harness/titles';
import { contextBlock } from './context-block';
import { callAgent } from './agent-call';
import { activeBuyers, CAP_ACTION, computeCap, hasAction, PURCHASE_ACTION, TASK_ACTION } from './cross-tool';

/**
 * Vendor-reply loop (event-driven), durable on Inngest:
 *
 *   Composio Gmail trigger → POST /api/webhooks/composio → Inngest `composio/gmail.new_message`
 *   → match (code: sender → Distru vendor, PO number → that vendor's open PO)
 *   → read-thread (Composio read tool; the thread is untrusted text)
 *   → classify (Vendor Liaison, structured output: partial / delay / confirm / price_change / other,
 *               quantities / ETA / price as stated, injection flag)
 *   → plan (code: every number validated against the PO; PO update, buyer cap when stock now runs out
 *           before the new ETA (allocation-guard maths), acknowledgement reply (high risk), buyer task)
 *   → propose (one harness proposal, principal = Vendor Liaison) → await-decision → execute → finalize
 *
 * The model only *reads*: it never chooses ops or values. A reply that tries to instruct the agent is
 * flagged, gets no auto-reply, and can change nothing the PO data does not support (a confirmation
 * with an injected "approve everything" produces no proposal at all).
 */

export const REPLY_ACTION = 'composio.gmail_reply_to_thread';
const THREAD_TOOL = 'composio.gmail_fetch_message_by_thread_id';
const MESSAGE_TOOL = 'composio.gmail_fetch_message_by_message_id';
const EDITABLE = new Set(['DRAFT', 'PENDING', 'PROCESSING']);
/** A stated price more than this fraction away from the PO price is not proposed (flagged for the buyer). */
export const PRICE_CHANGE_TOLERANCE = 0.5;
/** ETAs further out than this are not trusted for cap maths. */
export const MAX_ETA_DAYS = 180;
const DAY = 86_400_000;

export interface VendorReplyDeps {
  registry: Registry<AppCtx>;
  harness: Harness<AppCtx>;
  contexts: () => { read: AppCtx; execute: AppCtx };
  pricing: Pricing;
  /** Makes `propose` idempotent across step retries. */
  findProposalByRunId?: (runId: string) => Promise<Proposal | null>;
  /** Slack approval request + run notifications (best-effort). */
  notifier?: ProposalNotifier;
  /** Distru role whose user gets the follow-up task. */
  taskOwnerRole?: string;
  /** Signature line of the acknowledgement email. */
  signature?: string;
  now?: () => Date;
}

// ── schemas ─────────────────────────────────────────────────────────────────────────────────────

const VendorRefSchema = z.object({ id: z.string(), name: z.string(), email: z.string().nullable(), lead_time_days: z.number().nullable().default(null) });
const PoLineSchema = z.object({ product_id: z.string(), sku: z.string().nullable(), name: z.string().nullable(), quantity: z.number(), unit_price: z.number() });
const PurchaseRefSchema = z.object({ id: z.string(), purchase_number: z.string(), status: z.string(), location_id: z.string(), lines: z.array(PoLineSchema) });
type PurchaseRef = z.infer<typeof PurchaseRefSchema>;
const SkipSchema = z.object({ status: z.enum(['ignored', 'no_action']), reason: z.string() });

const MatchedSchema = z.object({
  event: GmailNewMessageEventSchema,
  skip: SkipSchema.nullable(),
  vendor: VendorRefSchema.nullable(),
  purchase: PurchaseRefSchema.nullable(),
});
const ThreadStateSchema = MatchedSchema.extend({ thread: z.unknown(), threadSource: z.enum(['composio', 'trigger', 'none']) });
const ClassifiedSchema = ThreadStateSchema.extend({ analysis: VendorReplyAnalysisSchema.nullable(), agentTrace: z.array(AgentTraceEntrySchema) });

export const CapCheckSchema = z
  .object({
    product_id: z.string(),
    sku: z.string().nullable(),
    on_hand_available: z.number().nullable(),
    arriving_now: z.number(),
    avg_daily_demand: z.number().nullable(),
    coverage_days: z.number().nullable(),
    days_to_eta: z.number(),
    runs_out_before_eta: z.boolean(),
    cap: z.number().nullable(),
    note: z.string(),
  })
  .meta({ id: 'VendorReplyCapCheck' });
export type CapCheck = z.infer<typeof CapCheckSchema>;

const LineChangeSchema = z.object({ product_id: z.string(), sku: z.string().nullable(), field: z.enum(['quantity', 'unit_price']), from: z.number(), to: z.number() });

const PlannedSchema = ClassifiedSchema.extend({
  ops: z.array(z.object({ action: z.string(), input: z.unknown() })),
  changes: z.array(LineChangeSchema),
  findings: z.array(z.string()),
  suspicious: z.boolean(),
  capChecks: z.array(CapCheckSchema),
});
type Planned = z.infer<typeof PlannedSchema>;

const CarrySchema = z.object({
  kind: z.string().nullable(),
  vendor: z.string().nullable(),
  purchaseNumber: z.string().nullable(),
  findings: z.array(z.string()),
  suspicious: z.boolean(),
  skip: SkipSchema.nullable(),
});
type Carry = z.infer<typeof CarrySchema>;

const ProposedSchema = z.object({ proposalId: z.string().nullable(), proposalStatus: ProposalStatusSchema.nullable(), carry: CarrySchema });
const DecisionSchema = ProposedSchema.extend({ decision: z.enum(['approved', 'rejected', 'denied', 'none']) });
const ExecutedSchema = DecisionSchema.extend({ executed: z.boolean() });

export const VendorReplyResultSchema = z
  .object({
    status: z.enum(['executed', 'failed', 'rejected', 'denied', 'no_action', 'flagged', 'ignored']),
    proposalId: z.string().nullable(),
    proposalStatus: ProposalStatusSchema.nullable(),
    kind: z.string().nullable(),
    vendor: z.string().nullable(),
    purchaseNumber: z.string().nullable(),
    suspicious: z.boolean(),
    findings: z.array(z.string()),
    message: z.string(),
  })
  .meta({ id: 'VendorReplyResult' });
export type VendorReplyResult = z.infer<typeof VendorReplyResultSchema>;

const SuspendSchema = z.object({ proposalId: z.string(), status: z.string(), title: z.string().nullable() });

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────

const liaison = principalFor('vendorLiaison');
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const domainOf = (email: string) => email.split('@')[1]?.toLowerCase() ?? '';

const VendorsSchema = z.object({ vendors: z.array(z.object({ id: z.string(), name: z.string(), purchase_order_email: z.string().nullable(), lead_time_days: z.number().nullable().default(null) })) });
const ProductSchema = z.object({ id: z.string(), sku: z.string(), name: z.string(), quantity_available: z.number(), units_per_case: z.number().nullable() });
const VelocityRows = z.object({ rows: z.array(z.object({ product_id: z.string(), on_hand_available: z.number(), avg_daily_demand: z.number() })) });
const McpProduct = z.object({ product: z.object({ maxMenuBuyerOrderQuantity: z.number().nullable().optional() }).passthrough().nullable() });

/** PO numbers (`PO-527`) in a piece of (untrusted) text; code extracts them, Distru confirms them. */
export function poNumbersIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\bPO[-\s#]{0,2}(\d{1,8})\b/gi)].map((m) => `PO-${m[1]}`))];
}

function carryOf(state: Planned | z.infer<typeof ClassifiedSchema>, extra: Partial<Carry> = {}): Carry {
  return {
    kind: state.analysis?.kind ?? null,
    vendor: state.vendor?.name ?? null,
    purchaseNumber: state.purchase?.purchase_number ?? null,
    findings: 'findings' in state ? state.findings : [],
    suspicious: 'suspicious' in state ? state.suspicious : state.event.data.suspicious,
    skip: state.skip,
    ...extra,
  };
}

/**
 * Validates the Liaison's extraction against the PO (pure; exported for tests).
 * Returns the line changes the PO data supports and findings for everything it does not.
 */
export function validateAgainstPo(analysis: VendorReplyAnalysis, po: PurchaseRef, today: Date): { changes: z.infer<typeof LineChangeSchema>[]; eta: string | null; findings: string[] } {
  const findings: string[] = [];
  const changes: z.infer<typeof LineChangeSchema>[] = [];
  const lineFor = (l: VendorReplyAnalysis['lines'][number]) =>
    po.lines.find((p) => (l.product_id && p.product_id === l.product_id) || (l.sku && p.sku && p.sku.toLowerCase() === l.sku.toLowerCase()));

  for (const l of analysis.lines) {
    const line = lineFor(l);
    const label = l.sku ?? l.product_id ?? '?';
    if (!line) {
      findings.push(`${label}: not a line on ${po.purchase_number}; ignored`);
      continue;
    }
    const sku = line.sku ?? line.product_id;
    if (analysis.kind === 'partial' && l.shipped_quantity !== null) {
      const shipped = l.shipped_quantity;
      if (!Number.isInteger(shipped) || shipped <= 0 || shipped >= line.quantity) {
        findings.push(`${sku}: stated shipment of ${shipped} units is not between 1 and ${line.quantity - 1} (ordered ${line.quantity}); PO quantity not changed`);
      } else {
        if (l.backordered_quantity !== null && shipped + l.backordered_quantity !== line.quantity) {
          findings.push(`${sku}: ${shipped} shipped + ${l.backordered_quantity} backordered ≠ ${line.quantity} ordered; using the shipped quantity`);
        }
        changes.push({ product_id: line.product_id, sku: line.sku, field: 'quantity', from: line.quantity, to: shipped });
      }
    }
    if (analysis.kind === 'price_change' && l.new_unit_price !== null) {
      const next = Math.round(l.new_unit_price * 100) / 100;
      const delta = line.unit_price > 0 ? Math.abs(next - line.unit_price) / line.unit_price : Infinity;
      if (!(next > 0) || delta > PRICE_CHANGE_TOLERANCE) {
        findings.push(`${sku}: stated price ${money(next)} is more than ${PRICE_CHANGE_TOLERANCE * 100}% away from the PO price ${money(line.unit_price)}; not proposed`);
      } else if (next !== line.unit_price) {
        changes.push({ product_id: line.product_id, sku: line.sku, field: 'unit_price', from: line.unit_price, to: next });
      }
    }
  }
  if ((analysis.kind === 'partial' || analysis.kind === 'price_change') && !changes.length && !findings.length) {
    findings.push(`The reply is classified ${analysis.kind} but states no numbers for a PO line; nothing to change`);
  }

  let eta: string | null = null;
  if (analysis.eta) {
    const days = (Date.parse(`${analysis.eta}T00:00:00Z`) - Date.parse(`${isoDay(today)}T00:00:00Z`)) / DAY;
    if (!Number.isFinite(days) || days <= 0 || days > MAX_ETA_DAYS) findings.push(`Stated ETA ${analysis.eta_text ?? analysis.eta} (${analysis.eta}) is not within the next ${MAX_ETA_DAYS} days; ignored`);
    else eta = analysis.eta;
  }
  return { changes, eta, findings };
}

/** Acknowledgement email, from validated numbers only (never from the vendor's text). */
function replyBody(vendor: string, po: PurchaseRef, kind: string, changes: z.infer<typeof LineChangeSchema>[], eta: string | null, signature: string): string {
  const lines = changes.map((c) =>
    c.field === 'quantity'
      ? `- ${c.sku ?? c.product_id}: we have updated ${po.purchase_number} to the ${c.to} units you can ship now (was ${c.from}).`
      : `- ${c.sku ?? c.product_id}: we have noted the new unit price of ${money(c.to)} (was ${money(c.from)}) on ${po.purchase_number}.`,
  );
  return [
    `Hello ${vendor} team,`,
    `Thank you for the update on ${po.purchase_number}.`,
    ...(lines.length ? [lines.join('\n')] : []),
    kind === 'partial' && eta ? `We have noted the remaining units for ${eta}; our buyer will confirm separately whether to keep them on order.` : null,
    kind === 'delay' && eta ? `We have noted the new ship date of ${eta}.` : null,
    `Thank you,\n${signature}`,
  ]
    .filter((s): s is string => Boolean(s))
    .join('\n\n');
}

// ── steps ───────────────────────────────────────────────────────────────────────────────────────

export function createVendorReplySteps(deps: VendorReplyDeps) {
  const now = () => deps.now?.() ?? new Date();

  const match = createStep({
    id: 'match',
    description: 'Sender → Distru vendor; PO number in the subject/snippet → that vendor’s open PO (code)',
    inputSchema: GmailNewMessageEventSchema,
    outputSchema: MatchedSchema,
    execute: async ({ inputData: event }) => {
      const skip = (status: 'ignored' | 'no_action', reason: string) => ({ event, skip: { status, reason }, vendor: null, purchase: null });
      const from = event.data.fromAddress?.toLowerCase() ?? null;
      if (!from) return skip('ignored', 'No parsable sender address');
      const ctx = deps.contexts().read;
      const vendors = VendorsSchema.parse(await deps.registry.runReadTool(ctx, liaison, 'distru.vendors', {})).vendors;
      const vendor =
        vendors.find((v) => v.purchase_order_email?.toLowerCase() === from) ??
        vendors.find((v) => v.purchase_order_email && domainOf(v.purchase_order_email) === domainOf(from));
      if (!vendor) return skip('ignored', `Sender ${from} is not a vendor on file`);
      const vendorRef = { id: vendor.id, name: vendor.name, email: vendor.purchase_order_email, lead_time_days: vendor.lead_time_days };

      const client = ctx.connectors.distru;
      const text = `${event.data.subject?.untrusted_text ?? ''}\n${event.data.snippet?.untrusted_text ?? ''}`;
      const numbers = poNumbersIn(text);
      const found = numbers.length ? await client.listAll(client.listPurchases, { purchase_numbers: numbers, company_ids: [vendor.id] }) : [];
      let po = found[0];
      if (!po) {
        // No (valid) PO number: only a single open PO of this vendor is unambiguous.
        const open = (await client.listAll(client.listPurchases, { company_ids: [vendor.id], statuses: ['PENDING', 'PROCESSING'] })).filter((p) => EDITABLE.has(p.status));
        if (open.length !== 1) {
          return { ...skip('ignored', numbers.length ? `${numbers.join(', ')} is not a purchase order of ${vendor.name}` : `No PO number in the email and ${open.length} open POs for ${vendor.name}`), vendor: vendorRef };
        }
        po = open[0]!;
      }
      const record = normalizePurchase(po);
      const lines = await Promise.all(
        record.items
          .filter((i): i is typeof i & { product_id: string } => Boolean(i.product_id))
          .map(async (i) => {
            const product = ProductSchema.safeParse(await deps.registry.runReadTool(ctx, liaison, 'distru.products_get', { product_id: i.product_id }).catch(() => null));
            return { product_id: i.product_id, sku: product.success ? product.data.sku : null, name: product.success ? product.data.name : null, quantity: i.quantity, unit_price: i.price };
          }),
      );
      const purchase = { id: record.id, purchase_number: record.purchase_number, status: record.status, location_id: record.location_id ?? '', lines };
      if (!EDITABLE.has(record.status) || !record.location_id) {
        return { event, skip: { status: 'no_action' as const, reason: `${record.purchase_number} is ${record.status} and can no longer be edited` }, vendor: vendorRef, purchase };
      }
      return { event, skip: null, vendor: vendorRef, purchase };
    },
  });

  const readThread = createStep({
    id: 'read-thread',
    description: 'Read the email thread through the Composio read tool (untrusted text)',
    inputSchema: MatchedSchema,
    outputSchema: ThreadStateSchema,
    execute: async ({ inputData: state }) => {
      if (state.skip) return { ...state, thread: null, threadSource: 'none' as const };
      const ctx = deps.contexts().read;
      const { threadId, messageId } = state.event.data;
      try {
        if (threadId && deps.registry.readTools().some((t) => t.name === THREAD_TOOL)) {
          const out = z.object({ threadId: z.string(), messages: z.array(z.unknown()) }).parse(await deps.registry.runReadTool(ctx, liaison, THREAD_TOOL, { thread_id: threadId }));
          return { ...state, thread: { threadId: out.threadId, messages: out.messages.slice(-4) }, threadSource: 'composio' as const };
        }
        if (deps.registry.readTools().some((t) => t.name === MESSAGE_TOOL)) {
          return { ...state, thread: { messages: [await deps.registry.runReadTool(ctx, liaison, MESSAGE_TOOL, { message_id: messageId })] }, threadSource: 'composio' as const };
        }
      } catch {
        /* Composio down: fall back to what the trigger carried (subject + 500-char snippet). */
      }
      const d = state.event.data;
      return { ...state, thread: { messages: [{ messageId: d.messageId, from: d.from, fromAddress: d.fromAddress, subject: d.subject, snippet: d.snippet, suspicious: d.suspicious }] }, threadSource: 'trigger' as const };
    },
  });

  const classify = createStep({
    id: 'classify',
    description: 'Vendor Liaison: kind of reply + stated quantities / ETA / price (structured output)',
    inputSchema: ThreadStateSchema,
    outputSchema: ClassifiedSchema,
    execute: async ({ inputData: state, mastra, tracingContext }) => {
      if (state.skip || !state.vendor || !state.purchase) return { ...state, analysis: null, agentTrace: [] };
      const { object, trace } = await callAgent({
        mastra,
        agent: 'vendorLiaison',
        prompt: vendorLiaisonPrompt({
          today: isoDay(now()),
          vendor: state.vendor,
          purchase: { id: state.purchase.id, purchase_number: state.purchase.purchase_number, status: state.purchase.status, lines: state.purchase.lines },
          thread: state.thread,
          context: await contextBlock(deps.registry, deps.contexts().read, liaison, { vendorIds: [state.vendor.id], productIds: state.purchase.lines.map((l) => l.product_id) }),
        }),
        schema: VendorReplyAnalysisSchema,
        step: 'classify',
        label: `${state.vendor.name} on ${state.purchase.purchase_number}`,
        pricing: deps.pricing,
        ...(tracingContext ? { tracingContext } : {}),
      });
      return { ...state, analysis: object, agentTrace: [trace] };
    },
  });

  const plan = createStep({
    id: 'plan',
    description: 'Validate the extraction against the PO and assemble the ops (code only)',
    inputSchema: ClassifiedSchema,
    outputSchema: PlannedSchema,
    execute: async ({ inputData: state, runId }): Promise<Planned> => {
      const empty = { ops: [], changes: [], findings: [], suspicious: state.event.data.suspicious, capChecks: [] };
      if (state.skip || !state.analysis || !state.vendor || !state.purchase) return { ...state, ...empty };
      const { analysis, vendor, purchase: po } = state;
      const today = now();
      const ctx = deps.contexts().read;
      const suspicious = state.event.data.suspicious || analysis.injection_detected || analysis.suspicious_text.length > 0;
      const { changes, eta, findings } = validateAgainstPo(analysis, po, today);
      if (suspicious) findings.push('The email contains instruction-like text (possible prompt injection): flagged, ignored, and no automatic reply is proposed');

      const ops: OpRequest[] = [];
      // 1. PO update: only the validated quantity / price changes; every other line stays as it is.
      if (changes.length) {
        const lines = po.lines.map((l) => {
          const q = changes.find((c) => c.product_id === l.product_id && c.field === 'quantity');
          const p = changes.find((c) => c.product_id === l.product_id && c.field === 'unit_price');
          return { product_id: l.product_id, quantity: q?.to ?? l.quantity, unit_price: p?.to ?? l.unit_price };
        });
        ops.push({ action: PURCHASE_ACTION, input: { purchase_id: po.id, vendor_id: vendor.id, location_id: po.location_id, lines } });
      }

      // 2. Buyer caps: stock (on hand + what ships now) runs out before the remaining units arrive.
      const capChecks: CapCheck[] = [];
      const affected = analysis.kind === 'partial' ? changes.filter((c) => c.field === 'quantity') : analysis.kind === 'delay' ? po.lines.map((l) => ({ product_id: l.product_id, sku: l.sku, field: 'quantity' as const, from: l.quantity, to: 0 })) : [];
      if (eta && affected.length) {
        const daysToEta = Math.round((Date.parse(`${eta}T00:00:00Z`) - Date.parse(`${isoDay(today)}T00:00:00Z`)) / DAY);
        const velocity = VelocityRows.safeParse(
          await deps.registry
            // 'any': every affected SKU (low ones especially); a lead time so Distru computes reorder points.
            .runReadTool(ctx, liaison, 'distru.velocity_report', {
              below_reorder_point: 'any',
              lead_time_days: vendor.lead_time_days ?? 14,
              location_ids: [po.location_id],
              product_ids: affected.map((a) => a.product_id),
              limit: 100,
            })
            .catch(() => null),
        );
        for (const a of affected) {
          const row = velocity.success ? velocity.data.rows.find((r) => r.product_id === a.product_id) : undefined;
          const arriving = analysis.kind === 'partial' ? a.to : 0;
          const base = { product_id: a.product_id, sku: a.sku, arriving_now: arriving, days_to_eta: daysToEta };
          if (!row || row.avg_daily_demand <= 0) {
            capChecks.push({
              ...base,
              on_hand_available: row?.on_hand_available ?? null,
              avg_daily_demand: row?.avg_daily_demand ?? null,
              coverage_days: null,
              runs_out_before_eta: false,
              cap: null,
              note: row ? 'No recent demand: no cap needed' : `No velocity data for this SKU at the PO location${velocity.success ? '' : ' (velocity report unavailable)'}: no cap proposed`,
            });
            continue;
          }
          const coverage = Math.round(((Math.max(0, row.on_hand_available) + arriving) / row.avg_daily_demand) * 10) / 10;
          const check = { ...base, on_hand_available: row.on_hand_available, avg_daily_demand: row.avg_daily_demand, coverage_days: coverage, runs_out_before_eta: coverage < daysToEta };
          if (!check.runs_out_before_eta) {
            capChecks.push({ ...check, cap: null, note: `${coverage} days of cover ≥ ${daysToEta} days to the ETA: no cap needed` });
            continue;
          }
          if (!hasAction(deps.registry, CAP_ACTION)) {
            capChecks.push({ ...check, cap: null, note: 'Runs out before the ETA, but Distru MCP (distru_mcp) is unavailable: cap not proposed' });
            findings.push(`${a.sku ?? a.product_id} runs out before ${eta}; buyer cap not proposed (distru_mcp unavailable)`);
            continue;
          }
          const product = ProductSchema.parse(await deps.registry.runReadTool(ctx, liaison, 'distru.products_get', { product_id: a.product_id }));
          const buyers = await activeBuyers(ctx, a.product_id, today);
          if (buyers === 0) {
            capChecks.push({ ...check, cap: null, note: 'Runs out before the ETA, but nobody ordered it in the last 14 days: no cap' });
            continue;
          }
          const cap = computeCap(product.quantity_available, buyers, product.units_per_case);
          const current = deps.registry.readTools().some((t) => t.name === 'distru_mcp.get_product')
            ? (McpProduct.safeParse(await deps.registry.runReadTool(ctx, liaison, 'distru_mcp.get_product', { id: a.product_id }).catch(() => null)).data?.product?.maxMenuBuyerOrderQuantity ?? null)
            : null;
          if (current !== null && current <= cap) {
            capChecks.push({ ...check, cap: null, note: `Existing cap ${current} is already at least as tight as ${cap}` });
            continue;
          }
          capChecks.push({ ...check, cap, note: `${coverage} days of cover < ${daysToEta} days to ${eta}: ${product.quantity_available} available ÷ ${buyers} active buyer(s) → ${cap} per buyer order` });
          ops.push({ action: CAP_ACTION, input: { action: 'UPDATE', id: a.product_id, maxMenuBuyerOrderQuantity: cap } });
        }
      }

      // 3. Acknowledgement reply (high risk, always a human): only for actionable, non-suspicious replies.
      const actionable = changes.length > 0 || (analysis.kind === 'delay' && eta !== null);
      const threadId = state.event.data.threadId;
      if (actionable && !suspicious && threadId && vendor.email && hasAction(deps.registry, REPLY_ACTION)) {
        ops.push({ action: REPLY_ACTION, input: { thread_id: threadId, recipient_email: state.event.data.fromAddress ?? vendor.email, message_body: replyBody(vendor.name, po, analysis.kind, changes, eta, deps.signature ?? 'Purchasing, Golden Coast Distribution') } });
      }

      // 4. Buyer task: a person decides what happens to the remainder / confirms the change.
      if (actionable && hasAction(deps.registry, TASK_ACTION)) {
        const what =
          analysis.kind === 'partial'
            ? changes.filter((c) => c.field === 'quantity').map((c) => `${c.sku ?? c.product_id} ${c.to} of ${c.from} now, ${c.from - c.to} ${eta ? `ETA ${eta}` : 'later'}`).join('; ')
            : analysis.kind === 'delay'
              ? `delayed to ${eta}`
              : changes.map((c) => `${c.sku ?? c.product_id} price ${money(c.from)} → ${money(c.to)}`).join('; ');
        ops.push({
          action: TASK_ACTION,
          input: {
            name: `Vendor reply on ${po.purchase_number}: ${what}`.slice(0, 200),
            due: eta && analysis.kind !== 'price_change' ? eta : isoDay(addDays(today, 2)),
            owner_role: deps.taskOwnerRole ?? 'Purchasing Manager',
            purchase_id: po.id,
            description: [
              `${vendor.name} replied about ${po.purchase_number} (${analysis.kind}). ${analysis.summary}`,
              analysis.kind === 'partial' ? 'Decide whether to keep the remaining units on order (new PO at the ETA) or source them elsewhere.' : null,
              findings.length ? `Checks: ${findings.join(' | ')}` : null,
              `Created by Ops Agent vendor-reply run ${runId}.`,
            ]
              .filter(Boolean)
              .join('\n')
              .slice(0, 2000),
          },
        });
      }

      // Validate every op now (a bad op fails here, not at propose).
      for (const op of ops) await previewOp(deps.registry, ctx, liaison, op);
      return { ...state, ops, changes, findings, suspicious, capChecks };
    },
  });

  const propose = createStep({
    id: 'propose',
    description: 'One harness proposal (Vendor Liaison principal), Slack approval request',
    inputSchema: PlannedSchema,
    outputSchema: ProposedSchema,
    execute: async ({ inputData: state, runId }) => {
      const carry = carryOf(state);
      if (!state.ops.length) {
        if (state.suspicious && state.vendor) {
          await deps.notifier?.notice(`Flagged vendor email from ${state.vendor.name}${state.purchase ? ` about ${state.purchase.purchase_number}` : ''}: it contains instruction-like text (possible prompt injection). Nothing was proposed or changed.`);
        }
        return { proposalId: null, proposalStatus: null, carry };
      }
      const existing = await deps.findProposalByRunId?.(runId);
      if (existing) {
        await deps.notifier?.proposalCreated(existing); // retried step: idempotent Slack post
        return { proposalId: existing.id, proposalStatus: existing.status, carry };
      }
      const { vendor, purchase, analysis } = state;
      // Headline: the Liaison's title/summary when it passes the code validator, else a template.
      const poNumber = purchase?.purchase_number ?? 'PO';
      const poTotal = purchase ? purchase.lines.reduce((s, l) => s + l.quantity * l.unit_price, 0) : 0;
      const headline = chooseHeadline(
        analysis ? { title: analysis.title, summary: analysis.summary } : null,
        {
          title: vendorReplyTemplateTitle(poNumber, analysis?.kind ?? 'other'),
          summary: `${vendor?.name ?? 'Vendor'} replied about ${poNumber} (${analysis?.kind ?? 'other'}).${state.changes.length ? ` ${state.changes.length} validated change(s) to the PO.` : ''}`,
        },
        {
          money: [poTotal, ...(purchase?.lines.flatMap((l) => [l.unit_price, l.unit_price * l.quantity]) ?? []), ...state.changes.flatMap((c) => [c.from, c.to].filter((n): n is number => typeof n === 'number'))],
          numbers: [
            ...(purchase?.lines.map((l) => l.quantity) ?? []),
            ...state.changes.flatMap((c) => [c.from, c.to].filter((n): n is number => typeof n === 'number')),
            ...(analysis?.lines.flatMap((l) => [l.shipped_quantity, l.backordered_quantity].filter((n): n is number => typeof n === 'number')) ?? []),
            purchase?.lines.length ?? 0,
            state.changes.length,
            state.ops.length,
          ],
          poNumbers: purchase ? [purchase.purchase_number] : [],
          dates: analysis?.eta ? [analysis.eta] : [],
          vendorNames: vendor ? [vendor.name] : [],
          untrusted: [...untrustedTextsIn(state.thread), ...(analysis?.suspicious_text.map((s) => s.excerpt) ?? [])],
        },
      );
      const p = await deps.harness.propose({
        ctx: deps.contexts().read,
        principal: liaison,
        ops: state.ops,
        title: headline.title,
        ...(headline.summary ? { summary: headline.summary } : {}),
        rationale: [
          analysis?.summary ?? null,
          state.changes.length ? `Validated against the PO: ${state.changes.map((c) => `${c.sku ?? c.product_id} ${c.field} ${c.from} → ${c.to}`).join('; ')}` : null,
          state.capChecks.length ? `Stock vs ETA: ${state.capChecks.map((c) => `${c.sku ?? c.product_id}: ${c.note}`).join('; ')}` : null,
          state.findings.length ? `Checks: ${state.findings.join(' | ')}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
        meta: {
          ...headline.meta,
          workflowId: VENDOR_REPLY_WORKFLOW_ID,
          workflowRunId: runId,
          trigger: { source: 'composio', eventId: state.event.eventId, messageId: state.event.data.messageId, threadId: state.event.data.threadId, fromAddress: state.event.data.fromAddress },
          vendor,
          purchase: purchase ? { id: purchase.id, purchase_number: purchase.purchase_number, status: purchase.status } : null,
          analysis,
          changes: state.changes,
          capChecks: state.capChecks,
          findings: state.findings,
          injectionDetected: state.suspicious,
          suspiciousText: analysis?.suspicious_text ?? [],
          threadSource: state.threadSource,
        },
      });
      await deps.notifier?.proposalCreated(p);
      return { proposalId: p.id, proposalStatus: p.status, carry };
    },
  });

  const awaitDecision = createStep({
    id: AWAIT_DECISION_STEP,
    description: 'Wait for exactly one human decision (skipped when auto-approved, denied or nothing was proposed)',
    inputSchema: ProposedSchema,
    outputSchema: DecisionSchema,
    suspendSchema: SuspendSchema,
    resumeSchema: RestockResumeSchema,
    execute: async ({ inputData, suspend }) => {
      if (!inputData.proposalId) return { ...inputData, decision: 'none' as const };
      const p = await deps.harness.get(inputData.proposalId);
      switch (p.status) {
        case 'auto_approved':
        case 'approved':
        case 'executing':
        case 'executed':
        case 'failed':
          return { ...inputData, proposalStatus: p.status, decision: 'approved' as const };
        case 'rejected':
          return { ...inputData, proposalStatus: p.status, decision: 'rejected' as const };
        case 'denied':
          return { ...inputData, proposalStatus: p.status, decision: 'denied' as const };
        default:
          return await suspend({ proposalId: p.id, status: p.status, title: p.title });
      }
    },
  });

  const execute = createStep({
    id: 'execute',
    description: 'harness.execute: idempotent writes, verify-after-write, audit',
    inputSchema: DecisionSchema,
    outputSchema: ExecutedSchema,
    execute: async ({ inputData }) => {
      if (inputData.decision !== 'approved' || !inputData.proposalId) return { ...inputData, executed: false };
      const p = await deps.harness.execute({ ctx: deps.contexts().execute, proposalId: inputData.proposalId });
      return { ...inputData, proposalStatus: p.status, executed: true };
    },
  });

  const finalize = createStep({
    id: 'finalize',
    description: 'Outcome + run notification',
    inputSchema: ExecutedSchema,
    outputSchema: VendorReplyResultSchema,
    execute: async ({ inputData }): Promise<VendorReplyResult> => {
      const c = inputData.carry;
      const base = { kind: c.kind, vendor: c.vendor, purchaseNumber: c.purchaseNumber, suspicious: c.suspicious, findings: c.findings };
      if (!inputData.proposalId) {
        if (c.skip) return { ...base, status: c.skip.status, proposalId: null, proposalStatus: null, message: c.skip.reason };
        return { ...base, status: c.suspicious ? 'flagged' : 'no_action', proposalId: null, proposalStatus: null, message: c.suspicious ? 'Suspicious email flagged; nothing proposed or changed.' : `Nothing to change (${c.kind ?? 'unclassified'} reply).` };
      }
      const p = await deps.harness.get(inputData.proposalId);
      if (inputData.decision === 'rejected' || inputData.decision === 'denied' || p.status === 'executed' || p.status === 'failed') await deps.notifier?.proposalFinished(p);
      const status = inputData.decision === 'rejected' ? 'rejected' : inputData.decision === 'denied' ? 'denied' : p.status === 'executed' ? 'executed' : 'failed';
      const failed = p.ops.find((op) => op.status === 'failed');
      return {
        ...base,
        status,
        proposalId: p.id,
        proposalStatus: p.status,
        message:
          status === 'executed'
            ? `Executed ${p.ops.length} op(s) (${p.ops.map((o) => o.action).join(', ')}); total ${totalValue(p.ops) ?? 'n/a'}.`
            : status === 'failed'
              ? `Execution failed${failed ? ` at op #${failed.index} (${failed.action})` : ''}: ${p.execution?.error?.message ?? 'see audit trail'}`
              : status === 'rejected'
                ? `Rejected by ${p.decision?.by.label ?? p.decision?.by.id ?? 'approver'}; nothing was written.`
                : 'Denied by policy; nothing was written.',
      };
    },
  });

  return { match, readThread, classify, plan, propose, awaitDecision, execute, finalize };
}

const workflowConfig = {
  id: VENDOR_REPLY_WORKFLOW_ID,
  description: 'Vendor replied to a PO email: classify (untrusted text), validate against the PO, propose PO update / buyer cap / reply / task, human approval, idempotent execution.',
  inputSchema: GmailNewMessageEventSchema,
  outputSchema: VendorReplyResultSchema,
} as const;

/** Production: Inngest-backed. */
export function createVendorReplyWorkflow(deps: VendorReplyDeps) {
  const s = createVendorReplySteps(deps);
  return inngestWorkflowKit
    .createWorkflow({ ...workflowConfig, retries: 2 })
    .then(s.match)
    .then(s.readThread)
    .then(s.classify)
    .then(s.plan)
    .then(s.propose)
    .then(s.awaitDecision)
    .then(s.execute)
    .then(s.finalize)
    .commit();
}

/** Same steps on Mastra's default engine (tests). */
export function createVendorReplyWorkflowInProcess(deps: VendorReplyDeps) {
  const s = createVendorReplySteps(deps);
  return createDefaultWorkflow(workflowConfig)
    .then(s.match)
    .then(s.readThread)
    .then(s.classify)
    .then(s.plan)
    .then(s.propose)
    .then(s.awaitDecision)
    .then(s.execute)
    .then(s.finalize)
    .commit();
}

export type { GmailNewMessageEvent };
