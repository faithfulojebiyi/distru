/**
 * Distru webhooks as a harness trigger (`distru.order_created`).
 *
 * Distru signs each delivery with `x-distru-signature: sha256=<hex HMAC-SHA256 of the raw body>` (the
 * mock does the same). The envelope is `{ type, event, id, object, changes, occurred_datetime }`; an
 * ORDER CREATE becomes `{ productIds, locationIds }` to restock-check, anything else is ignored.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { defineTrigger, headerValue, type TriggerVerification } from '@ops/harness';
import { z } from 'zod';

export const DISTRU_WEBHOOK_SECRET = 'DISTRU_WEBHOOK_SECRET';
export const DISTRU_ORDER_TRIGGER_ID = 'distru.order_created';

/** `sha256=<hex HMAC-SHA256 of the raw body>` (Distru's scheme, as the mock sends it). */
export function signDistruBody(rawBody: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/** Constant-time check of the signature header against the raw body. */
export function verifyDistruSignature(rawBody: string, header: string | undefined | null, secret: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(signDistruBody(rawBody, secret));
  const actual = Buffer.from(header.trim());
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const RefSchema = z.object({ id: z.string() }).nullish();

/** The fields we use from Distru's webhook envelope. */
export const DistruWebhookSchema = z.object({
  type: z.string(),
  event: z.string(),
  id: z.string(),
  object: z
    .object({
      location: RefSchema,
      items: z.array(z.object({ product: RefSchema, product_id: z.string().nullish() })).nullish(),
    })
    .nullish(),
});
export type DistruWebhook = z.infer<typeof DistruWebhookSchema>;

/** ORDER CREATE → the products (and receiving location) to restock-check; anything else → null. */
export function restockScopeFor(hook: DistruWebhook): { productIds: string[]; locationIds: string[] } | null {
  if (hook.type !== 'ORDER' || hook.event !== 'CREATE') return null;
  const productIds = [...new Set((hook.object?.items ?? []).map((i) => i.product?.id ?? i.product_id).filter((id): id is string => Boolean(id)))];
  if (!productIds.length) return null;
  const location = hook.object?.location?.id;
  return { productIds, locationIds: location ? [location] : [] };
}

export const DistruOrderCreatedEventSchema = z
  .object({
    source: z.literal('distru'),
    /** Distru's record id of the order (deliveries of the same order share it). */
    eventId: z.string(),
    orderId: z.string(),
    productIds: z.array(z.string()).min(1),
    locationIds: z.array(z.string()),
  })
  .meta({ id: 'DistruOrderCreatedEvent' });
export type DistruOrderCreatedEvent = z.infer<typeof DistruOrderCreatedEventSchema>;

export const distruOrderCreatedTrigger = defineTrigger<DistruOrderCreatedEvent>({
  id: DISTRU_ORDER_TRIGGER_ID,
  source: 'distru',
  description: 'A sales order was created in Distru (ORDER CREATE webhook): restock-check the ordered products at the order location.',
  eventName: 'distru/order.created',
  event: DistruOrderCreatedEventSchema,
  secret: DISTRU_WEBHOOK_SECRET,
  verify: (rawBody, headers, secrets): TriggerVerification => {
    if (!verifyDistruSignature(rawBody, headerValue(headers, 'x-distru-signature'), secrets[DISTRU_WEBHOOK_SECRET] ?? '')) {
      return { ok: false, reason: 'invalid_signature', message: 'Missing or invalid x-distru-signature' };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(rawBody);
    } catch {
      return { ok: false, reason: 'invalid_body', message: 'Body is not JSON' };
    }
    // Distru sends no delivery id header; the envelope id (+ type/event) identifies the event.
    const env = DistruWebhookSchema.safeParse(raw);
    if (!env.success) return { ok: false, reason: 'invalid_body', message: 'Not a Distru webhook envelope' };
    return { ok: true, webhookId: `${env.data.type}:${env.data.event}:${env.data.id}`, raw };
  },
  normalize: (raw, { eventId }) => {
    const hook = DistruWebhookSchema.parse(raw);
    const scope = restockScopeFor(hook);
    return scope ? { source: 'distru', eventId, orderId: hook.id, ...scope } : null;
  },
});
