/**
 * Composio triggers arriving as signed webhooks (Standard Webhooks headers `webhook-id`,
 * `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256 of id.timestamp.body>`).
 *
 * - `verifyComposioWebhook(rawBody, headers, secret)` checks the signature with the SDK's own
 *   verifier (`composio.triggers.verifyWebhook`) and never throws: `{ ok: true, … } | { ok: false, reason }`.
 * - `normalizeComposioEvent(payload)` turns the verified payload into a zod-validated, typed event
 *   (`gmail.new_message` today; anything else comes back as `trigger: 'other'`), with every piece
 *   of external text wrapped as untrusted.
 * - `inngestEventFor(event)` names it for Inngest (`composio/gmail.new_message`, id = webhook id
 *   so a redelivery is deduplicated).
 * - `gmailNewMessageTrigger` bundles all of that in the shape a future harness `defineTrigger` takes.
 */
import { Composio } from '@composio/core';
import { z } from 'zod';
import { addressesIn } from './messages';
import { untrusted, UntrustedTextSchema } from './untrusted';

export type HeaderBag = Headers | Record<string, string | string[] | undefined>;

function headerOf(headers: HeaderBag, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const found = Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
  return Array.isArray(found) ? found[0] : found;
}

let verifier: Composio | undefined;
/** The SDK instance used only for its (offline) webhook verifier. */
const verifierSdk = (): Composio => (verifier ??= new Composio({ apiKey: 'webhook-verifier', allowTracking: false, disableVersionCheck: true }));

export type ComposioWebhookVerification =
  | {
      ok: true;
      /** `webhook-id`: unique per event, stable across redeliveries (use as the dedupe key). */
      webhookId: string;
      version: string;
      /** The raw JSON body, parsed (V3: `{ id, type, timestamp, metadata, data }`). */
      raw: unknown;
      /** The SDK's normalized payload (`{ id, triggerSlug, userId, payload, metadata }`). */
      payload: unknown;
    }
  | { ok: false; reason: 'missing_headers' | 'bad_signature' | 'stale_timestamp' | 'bad_payload'; message: string };

/**
 * Verifies a Composio webhook. Pass the **raw** request body (before JSON parsing) and the request
 * headers. `toleranceSeconds` (default 300) bounds the timestamp's age; 0 disables the check.
 */
export async function verifyComposioWebhook(rawBody: string, headers: HeaderBag, secret: string, options: { toleranceSeconds?: number } = {}): Promise<ComposioWebhookVerification> {
  const id = headerOf(headers, 'webhook-id');
  const timestamp = headerOf(headers, 'webhook-timestamp');
  const signature = headerOf(headers, 'webhook-signature');
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing_headers', message: 'webhook-id, webhook-timestamp and webhook-signature are required' };
  try {
    const result = await verifierSdk().triggers.verifyWebhook({ payload: rawBody, id, timestamp, signature, secret, tolerance: options.toleranceSeconds ?? 300 });
    return { ok: true, webhookId: id, version: String(result.version), raw: result.rawPayload, payload: result.payload };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    const message = err instanceof Error ? err.message : String(err);
    const reason = /Payload/i.test(name) ? 'bad_payload' : /tolerance/i.test(message) ? 'stale_timestamp' : 'bad_signature';
    return { ok: false, reason, message };
  }
}

// ---------- normalized events ----------

export const GMAIL_NEW_MESSAGE_SLUG = 'GMAIL_NEW_GMAIL_MESSAGE';

export const GmailNewMessageDataSchema = z.object({
  messageId: z.string(),
  threadId: z.string().nullable(),
  fromAddress: z.string().nullable().describe('Parsed sender address (e.g. to match a vendor); anyone can send email'),
  from: UntrustedTextSchema.nullable(),
  to: z.array(z.string()),
  subject: UntrustedTextSchema.nullable(),
  snippet: UntrustedTextSchema.nullable().describe('First 500 chars of the body, untrusted'),
  labelIds: z.array(z.string()),
  /** Any free text in the message looks like a prompt injection. */
  suspicious: z.boolean(),
});

const EventBase = {
  source: z.literal('composio'),
  /** Unique event id (V3 body `id` = `webhook-id`); use for dedupe. */
  eventId: z.string(),
  triggerSlug: z.string(),
  triggerId: z.string().nullable(),
  connectedAccountId: z.string().nullable(),
  userId: z.string().nullable(),
  occurredAt: z.string(),
};

export const GmailNewMessageEventSchema = z.object({ ...EventBase, trigger: z.literal('gmail.new_message'), data: GmailNewMessageDataSchema });
export type GmailNewMessageEvent = z.infer<typeof GmailNewMessageEventSchema>;

export const OtherComposioEventSchema = z.object({ ...EventBase, trigger: z.literal('other'), data: z.record(z.string(), z.unknown()) });
export const ComposioEventSchema = z.discriminatedUnion('trigger', [GmailNewMessageEventSchema, OtherComposioEventSchema]);
export type ComposioEvent = z.infer<typeof ComposioEventSchema>;

/** Composio's V3 webhook body. */
const V3BodySchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  timestamp: z.string().optional(),
  metadata: z.looseObject({
    trigger_slug: z.string(),
    trigger_id: z.string().optional(),
    connected_account_id: z.string().optional(),
    user_id: z.string().optional(),
  }),
  data: z.record(z.string(), z.unknown()).default({}),
});

/** The SDK's normalized `IncomingTriggerPayload` (what `verifyWebhook().payload` gives). */
const SdkPayloadSchema = z.looseObject({
  id: z.string(),
  triggerSlug: z.string(),
  userId: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  metadata: z.looseObject({ id: z.string().optional(), connectedAccount: z.looseObject({ id: z.string().optional() }).optional() }).optional(),
});

/** Composio's GMAIL_NEW_GMAIL_MESSAGE payload (snake_case; unknown keys ignored). */
const GmailPayloadSchema = z.looseObject({
  message_id: z.string(),
  thread_id: z.string().nullish(),
  sender: z.string().nullish(),
  to: z.string().nullish(),
  subject: z.string().nullish(),
  message_text: z.string().nullish(),
  message_timestamp: z.string().nullish(),
  label_ids: z.array(z.string()).nullish(),
  preview: z.looseObject({ body: z.string().nullish(), subject: z.string().nullish() }).nullish(),
});

function gmailData(payload: Record<string, unknown>): z.infer<typeof GmailNewMessageDataSchema> {
  const p = GmailPayloadSchema.parse(payload);
  const text = p.message_text ?? p.preview?.body ?? '';
  const from = untrusted(p.sender, 'composio.trigger.gmail.from', 300);
  const subject = untrusted(p.subject ?? p.preview?.subject, 'composio.trigger.gmail.subject', 300);
  const snippet = untrusted(text, 'composio.trigger.gmail.snippet', 500);
  const whole = untrusted(text, 'composio.trigger.gmail.body', 20_000);
  return {
    messageId: p.message_id,
    threadId: p.thread_id ?? null,
    fromAddress: addressesIn(p.sender)[0] ?? null,
    from,
    to: addressesIn(p.to),
    subject,
    snippet,
    labelIds: p.label_ids ?? [],
    suspicious: Boolean(from?.suspicious || subject?.suspicious || whole?.suspicious),
  };
}

/**
 * Normalizes a Composio trigger payload: the raw V3 webhook body (`verification.raw`, or
 * `JSON.parse(rawBody)`) or the SDK's normalized payload (`verification.payload`). Throws a
 * ZodError when it is neither. Pass `eventId` (the `webhook-id`) when normalizing the SDK payload.
 */
export function normalizeComposioEvent(payload: unknown, options: { eventId?: string; receivedAt?: Date } = {}): ComposioEvent {
  const now = (options.receivedAt ?? new Date()).toISOString();
  const v3 = V3BodySchema.safeParse(payload);
  let base: Omit<z.infer<z.ZodObject<typeof EventBase>>, 'source'> & { data: Record<string, unknown> };
  if (v3.success) {
    const b = v3.data;
    base = {
      eventId: options.eventId ?? b.id,
      triggerSlug: b.metadata.trigger_slug,
      triggerId: b.metadata.trigger_id ?? null,
      connectedAccountId: b.metadata.connected_account_id ?? null,
      userId: b.metadata.user_id ?? null,
      occurredAt: b.timestamp ?? now,
      data: b.data,
    };
  } else {
    const s = SdkPayloadSchema.parse(payload);
    base = {
      eventId: options.eventId ?? s.id,
      triggerSlug: s.triggerSlug,
      triggerId: s.metadata?.id ?? s.id,
      connectedAccountId: s.metadata?.connectedAccount?.id ?? null,
      userId: s.userId ?? null,
      occurredAt: now,
      data: s.payload ?? {},
    };
  }
  if (base.triggerSlug.toUpperCase() === GMAIL_NEW_MESSAGE_SLUG) {
    const data = gmailData(base.data);
    const occurredAt = GmailPayloadSchema.safeParse(base.data).data?.message_timestamp ?? base.occurredAt;
    return GmailNewMessageEventSchema.parse({ ...base, source: 'composio', trigger: 'gmail.new_message', occurredAt, data });
  }
  return OtherComposioEventSchema.parse({ ...base, source: 'composio', trigger: 'other' });
}

/** The Inngest event for a normalized Composio event (`id` dedupes redeliveries for 24h). */
export function inngestEventFor(event: ComposioEvent): { name: string; id: string; data: ComposioEvent } {
  return { name: event.trigger === 'other' ? `composio/${event.triggerSlug.toLowerCase()}` : `composio/${event.trigger}`, id: `composio:${event.eventId}`, data: event };
}

/**
 * A trigger definition in the shape a harness `defineTrigger` could take (see README "Triggers").
 * Typed loosely on purpose: the harness has no trigger concept yet.
 */
export interface ComposioTriggerDefinition<TEvent> {
  readonly kind: 'trigger';
  readonly id: string;
  readonly source: 'composio';
  /** The Composio trigger type slug to enable on a connected account. */
  readonly providerSlug: string;
  readonly description: string;
  /** Inngest event name the app emits. */
  readonly eventName: string;
  readonly event: z.ZodType<TEvent>;
  verify(rawBody: string, headers: HeaderBag, secret: string): Promise<ComposioWebhookVerification>;
  normalize(payload: unknown, options?: { eventId?: string }): TEvent | null;
}

export const gmailNewMessageTrigger: ComposioTriggerDefinition<GmailNewMessageEvent> = {
  kind: 'trigger',
  id: 'composio.gmail.new_message',
  source: 'composio',
  providerSlug: GMAIL_NEW_MESSAGE_SLUG,
  description: 'A new email arrived in the connected Gmail mailbox (e.g. a vendor replying to a PO). Sender, subject and body are untrusted.',
  eventName: 'composio/gmail.new_message',
  event: GmailNewMessageEventSchema,
  verify: verifyComposioWebhook,
  normalize: (payload, options) => {
    const e = normalizeComposioEvent(payload, options);
    return e.trigger === 'gmail.new_message' ? e : null;
  },
};
