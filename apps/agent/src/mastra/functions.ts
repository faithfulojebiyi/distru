import type { InngestFunction } from 'inngest';
import { inngest, RESTOCK_REQUESTED_EVENT } from './inngest';
import { morningRestockTrigger } from '../harness/triggers';
import { RestockTriggerSchema, type RestockLauncher } from './restock-launcher';
import { DistruOrderCreatedEventSchema } from '@ops/connector-distru';
import { DISTRU_RECORD_CHANGED_EVENT } from '../api/distru-webhook';
import { z } from 'zod';

/** Emitted by POST /api/webhooks/distru: the `distru.order_created` trigger's own event name. */
export const DISTRU_ORDER_CREATED_EVENT = 'distru/order.created';

/** `distru/order.created` → the restock run scoped to the ordered products at the order location. */
export function restockTriggerForOrder(data: unknown) {
  const order = DistruOrderCreatedEventSchema.parse(data);
  return RestockTriggerSchema.parse({
    triggeredBy: `webhook:distru (ORDER ${order.orderId})`,
    productIds: order.productIds,
    ...(order.locationIds.length ? { locationIds: order.locationIds } : {}),
    scenarioNote: `New sales order ${order.orderId}: check whether the ordered products need restocking.`,
  });
}

/** Emitted by POST /api/webhooks/composio (trigger `composio.gmail.new_message`). */
export const COMPOSIO_GMAIL_EVENT = 'composio/gmail.new_message';

export interface RestockFunctionOptions {
  /** Register the morning cron (RESTOCK_CRON_ENABLED=1). */
  cronEnabled: boolean;
  /** Inngest cron expression, e.g. `TZ=America/Los_Angeles 0 7 * * *`. */
  cron: string;
}

/**
 * Inngest functions that start restock runs. Inngest owns the triggers (cron state, event
 * delivery, retries); each function only starts the Mastra workflow in a memoized step, so a retry
 * never starts a second run.
 *
 * - `restock-on-event`: `ops/restock.requested` (sent by POST /api/webhooks/distru on ORDER CREATE,
 *   scoped to the ordered products/location).
 * - `restock-cron`: every morning, only when enabled. (With @mastra/inngest, Mastra's own `schedule`
 *   is replaced by Inngest cron; a dedicated function keeps it switchable by env.)
 */
export function createRestockFunctions(launcher: RestockLauncher, options: RestockFunctionOptions): InngestFunction.Like[] {
  const onEvent = inngest.createFunction(
    { id: 'restock-on-event', name: 'Restock: on event', triggers: [{ event: RESTOCK_REQUESTED_EVENT }] },
    async ({ event, step }) => {
      const input = RestockTriggerSchema.parse(event.data);
      return step.run('start-restock-run', () => launcher.start(input));
    },
  );
  // The Distru ORDER CREATE trigger's event (deduped by Inngest on `distru.order_created:<type:id:occurred>`).
  const onOrder = inngest.createFunction(
    { id: 'restock-on-distru-order', name: 'Restock: on Distru order', triggers: [{ event: DISTRU_ORDER_CREATED_EVENT }] },
    async ({ event, step }) => step.run('start-restock-run', () => launcher.start(restockTriggerForOrder(event.data))),
  );
  if (!options.cronEnabled) return [onEvent, onOrder];
  // The schedule trigger (`schedule.morning_restock`) owns the cron expression.
  const schedule = morningRestockTrigger(options.cron);
  const cron = inngest.createFunction({ id: 'restock-cron', name: 'Restock: morning scan', triggers: [{ cron: schedule.cron }] }, async ({ step }) =>
    step.run('start-restock-run', () => launcher.start({ triggeredBy: 'cron', scenarioNote: 'Scheduled morning restock scan' })),
  );
  return [onEvent, onOrder, cron];
}

/**
 * `vendor-reply-on-email`: a verified Composio Gmail event (deduped by Inngest on the event id) starts
 * one vendor-reply run in a memoized step, so an Inngest retry never starts a second run. The
 * workflow itself ignores mail that is not a vendor reply to an open PO.
 */
export function createVendorReplyFunctions(launcher: RestockLauncher): InngestFunction.Like[] {
  return [
    inngest.createFunction({ id: 'vendor-reply-on-email', name: 'Vendor reply: on email', triggers: [{ event: COMPOSIO_GMAIL_EVENT }] }, async ({ event, step }) =>
      step.run('start-vendor-reply-run', () => launcher.startVendorReply(event.data)),
    ),
  ];
}

export interface ContextFunctionOptions {
  /** Inngest cron for sync → profile; empty disables. */
  cron: string;
  /** `sync.run()` then `buildProfile()`. */
  syncAndProfile: () => Promise<unknown>;
  /** `sync.handleWebhook(body)` (re-reads the record by id; deduped on type, id, occurred_datetime). */
  handleWebhook: (body: { type: string; id: string; occurred_datetime: string }) => Promise<unknown>;
}

const RecordChangedSchema = z.object({ type: z.string(), id: z.string(), event: z.string().optional(), occurred_datetime: z.string().nullable() });

/**
 * Context layer: `context-sync` (cron, default every 30 min: incremental Distru sync, then a fresh
 * account profile) and `context-record-sync` (`distru/record.changed`: re-read one record by id).
 */
export function createContextFunctions(options: ContextFunctionOptions): InngestFunction.Like[] {
  const record = inngest.createFunction(
    { id: 'context-record-sync', name: 'Context: sync a changed Distru record', triggers: [{ event: DISTRU_RECORD_CHANGED_EVENT }], concurrency: { limit: 4 } },
    async ({ event, step }) => {
      const hook = RecordChangedSchema.parse(event.data);
      return step.run('sync-record', () => options.handleWebhook({ type: hook.type, id: hook.id, occurred_datetime: hook.occurred_datetime ?? new Date(event.ts ?? Date.now()).toISOString() }));
    },
  );
  if (!options.cron) return [record];
  const cron = inngest.createFunction(
    { id: 'context-sync', name: 'Context: sync + profile', triggers: [{ cron: options.cron }], concurrency: { limit: 1 } },
    async ({ step }) => step.run('sync-and-profile', () => options.syncAndProfile()),
  );
  return [record, cron];
}

export interface RecallFunctionOptions {
  /** Inngest cron for the incremental mailbox pass; empty disables (arrivals are still indexed). */
  cron: string;
  /** One incremental pass over the purchasing mailbox (Composio Gmail, `after:` cursor). */
  indexMailbox: () => Promise<unknown>;
  /** Index one message from a `composio/gmail.new_message` event (vendor replies as they arrive). */
  indexIncoming: (event: unknown) => Promise<unknown>;
}

/**
 * Semantic recall indexing: `recall-index-on-email` (the same Gmail trigger event the vendor-reply loop
 * consumes; a second, independent function, so indexing never delays or breaks a reply run) and
 * `recall-index` (cron: the incremental mailbox pass, catching mail the trigger never saw, e.g. our own
 * sent messages). PO notes are indexed by the context sync (`onFreeText`), not here.
 */
export function createRecallFunctions(options: RecallFunctionOptions): InngestFunction.Like[] {
  const onEmail = inngest.createFunction(
    { id: 'recall-index-on-email', name: 'Recall: index an arriving email', triggers: [{ event: COMPOSIO_GMAIL_EVENT }], concurrency: { limit: 2 } },
    async ({ event, step }) => step.run('index-message', () => options.indexIncoming(event.data)),
  );
  if (!options.cron) return [onEmail];
  const cron = inngest.createFunction(
    { id: 'recall-index', name: 'Recall: index the mailbox', triggers: [{ cron: options.cron }], concurrency: { limit: 1 } },
    async ({ step }) => step.run('index-mailbox', () => options.indexMailbox()),
  );
  return [onEmail, cron];
}
