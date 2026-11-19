import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/** `x-distru-signature: sha256=<hex HMAC-SHA256 of the raw body>` (Distru's scheme, as the mock sends it). */
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

/** The fields we use from Distru's webhook envelope `{ type, event, id, object, changes, occurred_datetime }`. */
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
