import type { InngestFunction } from 'inngest';
import { inngest, RESTOCK_REQUESTED_EVENT } from './inngest';
import { morningRestockTrigger } from '../harness/triggers';
import { RestockTriggerSchema, type RestockLauncher } from './restock-launcher';

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
  if (!options.cronEnabled) return [onEvent];
  // The schedule trigger (`schedule.morning_restock`) owns the cron expression.
  const schedule = morningRestockTrigger(options.cron);
  const cron = inngest.createFunction({ id: 'restock-cron', name: 'Restock: morning scan', triggers: [{ cron: schedule.cron }] }, async ({ step }) =>
    step.run('start-restock-run', () => launcher.start({ triggeredBy: 'cron', scenarioNote: 'Scheduled morning restock scan' })),
  );
  return [onEvent, cron];
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
