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
