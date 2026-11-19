/**
 * Gmail messages as Composio returns them (`messageId`, `threadId`, `sender`, `subject`,
 * `messageText`, `preview`, `labelIds`, `messageTimestamp`, …), trimmed for an LLM: ids, dates and
 * plain addresses as trusted fields; sender display name, subject, snippet and body as untrusted.
 */
import { z } from 'zod';
import { stripMarker } from './marker';
import { untrusted, UntrustedTextSchema } from './untrusted';

/** Composio's Gmail message shape (fields we use; everything optional, unknown keys ignored). */
export const RawGmailMessageSchema = z.looseObject({
  messageId: z.string().optional(),
  id: z.string().optional(),
  threadId: z.string().nullish(),
  labelIds: z.array(z.string()).nullish(),
  messageTimestamp: z.string().nullish(),
  sender: z.string().nullish(),
  to: z.string().nullish(),
  subject: z.string().nullish(),
  messageText: z.string().nullish(),
  preview: z.looseObject({ subject: z.string().nullish(), body: z.string().nullish() }).nullish(),
});
export type RawGmailMessage = z.infer<typeof RawGmailMessageSchema>;

const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Plain addresses found in a header value (`"Ray" <orders@x.com>, b@y.com` → both, lower-cased). */
export const addressesIn = (header: string | null | undefined): string[] => [...new Set((header ?? '').match(EMAIL)?.map((a) => a.toLowerCase()) ?? [])];

export const EmailSummarySchema = z.object({
  messageId: z.string(),
  threadId: z.string().nullable(),
  date: z.string().nullable(),
  fromAddress: z.string().nullable().describe('Sender address (parsed; trusted format, but anyone can send email)'),
  from: UntrustedTextSchema.nullable().describe('Sender header incl. display name (untrusted)'),
  to: z.array(z.string()).describe('Recipient addresses'),
  subject: UntrustedTextSchema.nullable(),
  snippet: UntrustedTextSchema.nullable(),
  labelIds: z.array(z.string()),
  suspicious: z.boolean().describe('True when any free text in this message looks like a prompt injection'),
});
export type EmailSummary = z.infer<typeof EmailSummarySchema>;

export const EmailMessageSchema = EmailSummarySchema.extend({
  body: UntrustedTextSchema.nullable().describe('Plain-text body (untrusted, capped)'),
});
export type EmailMessage = z.infer<typeof EmailMessageSchema>;

const SNIPPET_MAX = 280;
export const BODY_MAX = 4000;

export function summarizeMessage(raw: unknown, source = 'composio.gmail'): EmailSummary | null {
  const parsed = RawGmailMessageSchema.safeParse(raw);
  if (!parsed.success) return null;
  const m = parsed.data;
  const messageId = m.messageId ?? m.id;
  if (!messageId) return null;
  const text = stripMarker(m.messageText ?? m.preview?.body ?? '');
  const from = untrusted(m.sender, `${source}.from`, 300);
  const subject = untrusted(m.subject ?? m.preview?.subject, `${source}.subject`, 300);
  const snippet = untrusted(text.replace(/\s+/g, ' '), `${source}.snippet`, SNIPPET_MAX);
  const fullSuspicious = untrusted(text, `${source}.body`, BODY_MAX)?.suspicious ?? false;
  return {
    messageId,
    threadId: m.threadId ?? null,
    date: m.messageTimestamp ?? null,
    fromAddress: addressesIn(m.sender)[0] ?? null,
    from,
    to: addressesIn(m.to),
    subject,
    snippet,
    labelIds: m.labelIds ?? [],
    suspicious: Boolean(from?.suspicious || subject?.suspicious || snippet?.suspicious || fullSuspicious),
  };
}

export function describeMessage(raw: unknown, source = 'composio.gmail'): EmailMessage | null {
  const summary = summarizeMessage(raw, source);
  if (!summary) return null;
  const m = RawGmailMessageSchema.parse(raw);
  return { ...summary, body: untrusted(stripMarker(m.messageText ?? ''), `${source}.body`, BODY_MAX) };
}

/** `data.messages` of a Composio Gmail list/thread result. */
export function messagesOf(data: unknown): unknown[] {
  const parsed = z.looseObject({ messages: z.array(z.unknown()).nullish() }).safeParse(data);
  return parsed.success ? (parsed.data.messages ?? []) : [];
}
