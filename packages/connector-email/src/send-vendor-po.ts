/**
 * `send_vendor_po` (registry name `email.send_vendor_po`, tool `propose_email_send_vendor_po`).
 *
 * Risk `high`: email cannot be unsent. There is no `compensate`/undo for this action, so the
 * harness never auto-approves it (`auto_approve_below` refuses high-risk ops) and a human always
 * sees the exact message (from, to, cc, subject, body) before it goes out.
 */
import { defineAction, deepEqual, diff, InputValidationError, type FieldChange } from '@ops/harness';
import { z } from 'zod';
import { markdownToHtml, markdownToText } from './render';
import { domainOf, type EmailCtx } from './shared';
import type { SentEmail } from './transport';

const SingleLine = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((s) => !/[\r\n]/.test(s), 'must be a single line');

export const SendVendorPoInputSchema = z
  .object({
    to: z.email().max(254).describe("Vendor's purchase-order email address"),
    cc: z.array(z.email().max(254)).max(10).optional().describe('Optional CC recipients'),
    vendor_name: SingleLine.describe('Vendor display name, for the subject and summary'),
    po_number: SingleLine.optional().describe('ERP purchase-order number, e.g. PO-123'),
    purchase_id: z.string().min(1).max(100).optional().describe('ERP purchase id this email is about (for traceability)'),
    subject: SingleLine.optional().describe('Subject line; defaults to "Purchase order <po_number> – <vendor_name>"'),
    body_markdown: z.string().trim().min(1).max(20_000).describe('Message body in simple Markdown (paragraphs, - lists, **bold**, [links](https://…))'),
    attach_po_pdf_link: z.url({ protocol: /^https$/ }).optional().describe('HTTPS link to the PO PDF, appended to the message'),
  })
  .refine((v) => !(v.cc ?? []).some((c) => c.toLowerCase() === v.to.toLowerCase()), { message: 'cc must not repeat the recipient', path: ['cc'] });
export type SendVendorPoInput = z.infer<typeof SendVendorPoInputSchema>;

/** The exact message that will be sent (the proposal payload). */
export const VendorPoEmailSchema = z.object({
  from: z.string().min(1),
  to: z.array(z.email()).min(1),
  cc: z.array(z.email()),
  subject: z.string().min(1),
  text: z.string(),
  html: z.string(),
  po_pdf_link: z.string().nullable(),
  context: z.object({ vendor_name: z.string(), po_number: z.string().nullable(), purchase_id: z.string().nullable() }),
});
export type VendorPoEmail = z.infer<typeof VendorPoEmailSchema>;

const dedupe = (xs: string[]) => [...new Set(xs.map((x) => x.toLowerCase()))];

export function planVendorPoEmail(from: string, input: SendVendorPoInput): VendorPoEmail {
  const subject = input.subject ?? (input.po_number ? `Purchase order ${input.po_number} – ${input.vendor_name}` : `Purchase order – ${input.vendor_name}`);
  const link = input.attach_po_pdf_link ?? null;
  const md = link ? `${input.body_markdown}\n\n[Download the purchase order (PDF)](${link})` : input.body_markdown;
  return {
    from,
    to: [input.to.toLowerCase()],
    cc: dedupe(input.cc ?? []),
    subject,
    text: markdownToText(md),
    html: markdownToHtml(md),
    po_pdf_link: link,
    context: { vendor_name: input.vendor_name, po_number: input.po_number ?? null, purchase_id: input.purchase_id ?? null },
  };
}

/** Diff shown to the approver: every message field as added (html omitted: it mirrors `text`). */
export function emailDiff(payload: VendorPoEmail): FieldChange[] {
  const { html: _html, context: _context, ...visible } = payload;
  return diff(null, visible);
}

const sameSet = (a: readonly string[], b: readonly string[]) => deepEqual([...a].map((x) => x.toLowerCase()).sort(), [...b].map((x) => x.toLowerCase()).sort());

export const sendVendorPoAction = defineAction({
  name: 'send_vendor_po',
  resource: 'emails',
  risk: 'high',
  requiredScope: 'propose',
  description:
    'Propose emailing a purchase order to a vendor. Always needs human approval (email cannot be unsent). The approver sees the exact message: from, to, cc, subject and body.',
  input: SendVendorPoInputSchema,
  payload: VendorPoEmailSchema,

  loadBefore: async (): Promise<SentEmail | null> => null,

  plan: (ctx: EmailCtx, input) => {
    const from = ctx.connectors.email.from;
    if (!from) throw new InputValidationError('No sender configured (EMAIL_FROM)');
    return planVendorPoEmail(from, input);
  },

  diff: (_before, payload) => emailDiff(payload),

  execute: async (ctx: EmailCtx, payload, idempotencyKey) => {
    const { transport } = ctx.connectors.email;
    const { messageId } = await transport.send({ from: payload.from, to: payload.to, cc: payload.cc, subject: payload.subject, text: payload.text, html: payload.html, idempotencyKey });
    const sent = (await transport.findByIdempotencyKey(idempotencyKey)) ?? (await transport.get(messageId));
    const record: SentEmail = sent ?? { from: payload.from, to: payload.to, cc: payload.cc, subject: payload.subject, text: payload.text, html: payload.html, messageId, idempotencyKey, sentAt: '' };
    return { recordId: messageId, record };
  },

  findByIdempotencyKey: async (ctx: EmailCtx, idempotencyKey) => {
    const sent = await ctx.connectors.email.transport.findByIdempotencyKey(idempotencyKey);
    return sent ? { recordId: sent.messageId, record: sent } : null;
  },

  verify: async (ctx: EmailCtx, recordId, expected) => {
    const sent = await ctx.connectors.email.transport.get(recordId);
    if (!sent) return { ok: false, mismatches: [{ path: [], expected: { to: expected.to, subject: expected.subject }, actual: null }] };
    const mismatches = [];
    if (!sameSet(sent.to, expected.to)) mismatches.push({ path: ['to'], expected: expected.to, actual: sent.to });
    if (!sameSet(sent.cc, expected.cc)) mismatches.push({ path: ['cc'], expected: expected.cc, actual: sent.cc });
    if (sent.subject !== expected.subject) mismatches.push({ path: ['subject'], expected: expected.subject, actual: sent.subject });
    return { ok: mismatches.length === 0, mismatches };
  },

  // An email moves no money: it counts as 0 toward value rules (so `max_total_value` still applies
  // to a proposal that pairs a PO with its vendor email). `valueOf` stays an own `undefined` so the
  // harness never falls back to Object.prototype.valueOf.
  valueOf: undefined,
  moneyless: true,

  summarize: (input, payload) => {
    const what = input.po_number ?? 'PO';
    const cc = payload.cc.length ? ` (cc ${payload.cc.length})` : '';
    return `Email ${what} to ${payload.to.join(', ')}${cc} – ${input.vendor_name}`;
  },
});

/** Recipient domains of an email payload (for policy rules). */
export const recipientDomains = (payload: Pick<VendorPoEmail, 'to' | 'cc'>): string[] => dedupe([...payload.to, ...payload.cc].map(domainOf));
