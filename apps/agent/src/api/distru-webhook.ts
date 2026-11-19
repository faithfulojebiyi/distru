/**
 * The Distru webhook logic now lives on the Distru connector's trigger (`distru.order_created`,
 * packages/connector-distru/src/webhooks.ts); re-exported here for existing imports.
 */
export {
  DistruWebhookSchema,
  distruOrderCreatedTrigger,
  DistruOrderCreatedEventSchema,
  DISTRU_ORDER_TRIGGER_ID,
  restockScopeFor,
  signDistruBody,
  verifyDistruSignature,
  type DistruWebhook,
} from '@ops/connector-distru';

/** Queued for every verified PRODUCT / PURCHASE / ORDER / COMPANY webhook: the context sync re-reads that record. */
export const DISTRU_RECORD_CHANGED_EVENT = 'distru/record.changed';
