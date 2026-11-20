/**
 * Distru webhooks as a harness trigger (`distru.order_created`).
 *
 * Distru signs each delivery with `x-distru-signature: sha256=<hex HMAC-SHA256 of the raw body>` (the
 * mock does the same). The envelope is `{ type, event, id, object, changes, occurred_datetime }`; an
 * ORDER CREATE becomes `{ productIds, locationIds }` to restock-check, anything else is ignored.
 *
 * Replay protection: with a tolerance (`createDistruOrderCreatedTrigger({ toleranceSeconds })`, the app's
 * DISTRU_WEBHOOK_TOLERANCE_SECONDS, default 300 in production) a delivery whose signed `occurred_datetime`
 * is older (or further in the future) than the tolerance is rejected, so a captured body cannot be replayed
 * later. Distru keeps `occurred_datetime` on its retries, so a retry after the window is refused too.
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
  /** When the change happened; with type + id it identifies one change across Distru's retries. */
  occurred_datetime: z.string().nullish(),
  object: z
    .object({
      location: RefSchema,
      items: z.array(z.object({ product: RefSchema, product_id: z.string().nullish() })).nullish(),
    })
    .nullish(),
});
export type DistruWebhook = z.infer<typeof DistruWebhookSchema>;

/**
 * Dedupe key of one Distru change. Distru sends no delivery id and retries a webhook ~10 times over
 * ~4 h, so (type, id, occurred_datetime) identifies the change; the queue event id is built from it
 * (`distru.order_created:<key>`), so every redelivery is a no-op. Without occurred_datetime: (type, event, id).
 */
export function distruWebhookKey(hook: Pick<DistruWebhook, 'type' | 'event' | 'id' | 'occurred_datetime'>): string {
  return hook.occurred_datetime ? `${hook.type}:${hook.id}:${hook.occurred_datetime}` : `${hook.type}:${hook.event}:${hook.id}`;
}

/** Record types the context sync re-reads by id on a webhook. */
export const DISTRU_SYNC_RECORD_TYPES = ['PRODUCT', 'PURCHASE', 'ORDER', 'COMPANY'] as const;

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

export interface DistruTriggerOptions {
  /** Max age (and future skew) of `occurred_datetime`, in seconds. 0 / unset = no check. */
  toleranceSeconds?: number;
  now?: () => Date;
}

/**
 * Freshness of a delivery's signed timestamp: null when within `toleranceSeconds` of now (or the check is
 * off), else why it is refused. A missing / unparseable timestamp is refused while the check is on.
 */
export function distruTimestampProblem(occurred: string | null | undefined, toleranceSeconds: number, now: Date): string | null {
  if (!toleranceSeconds) return null;
  if (!occurred) return 'Missing occurred_datetime';
  const at = Date.parse(occurred);
  if (Number.isNaN(at)) return 'Unparseable occurred_datetime';
  const skewSeconds = (now.getTime() - at) / 1000;
  if (skewSeconds > toleranceSeconds) return `Delivery is ${Math.round(skewSeconds)}s old (tolerance ${toleranceSeconds}s)`;
  if (-skewSeconds > toleranceSeconds) return `Delivery is ${Math.round(-skewSeconds)}s in the future (tolerance ${toleranceSeconds}s)`;
  return null;
}

/** The `distru.order_created` trigger, optionally rejecting stale deliveries (see `DistruTriggerOptions`). */
export function createDistruOrderCreatedTrigger(options: DistruTriggerOptions = {}) {
  const tolerance = options.toleranceSeconds ?? 0;
  const now = options.now ?? (() => new Date());
  return defineTrigger<DistruOrderCreatedEvent>({
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
      // Distru sends no delivery id header; (type, id, occurred_datetime) identifies the change.
      const env = DistruWebhookSchema.safeParse(raw);
      if (!env.success) return { ok: false, reason: 'invalid_body', message: 'Not a Distru webhook envelope' };
      // The timestamp is inside the signed body, so an old capture cannot be refreshed without the secret.
      const stale = distruTimestampProblem(env.data.occurred_datetime, tolerance, now());
      if (stale) return { ok: false, reason: 'stale_delivery', message: stale };
      return { ok: true, webhookId: distruWebhookKey(env.data), raw };
    },
    normalize: (raw, { eventId }) => {
      const hook = DistruWebhookSchema.parse(raw);
      const scope = restockScopeFor(hook);
      return scope ? { source: 'distru', eventId, orderId: hook.id, ...scope } : null;
    },
  });
}

/** The trigger without a freshness check (the connector's registered trigger; the app builds its own with the tolerance). */
export const distruOrderCreatedTrigger = createDistruOrderCreatedTrigger();
