import { defineTrigger, type AnyTrigger } from '@ops/harness';
import { z } from 'zod';
import { env } from '../env';
import { slackInteractionTrigger } from '../slack/trigger';

export const MORNING_RESTOCK_TRIGGER_ID = 'schedule.morning_restock';

export const MorningRestockTickSchema = z.object({ source: z.literal('schedule'), eventId: z.string() }).meta({ id: 'MorningRestockTick' });

/** The morning restock scan as a schedule trigger (Inngest cron; registered only when RESTOCK_CRON_ENABLED). */
export function morningRestockTrigger(cron: string) {
  return defineTrigger({
    id: MORNING_RESTOCK_TRIGGER_ID,
    source: 'schedule',
    delivery: 'schedule',
    cron,
    description: 'Every morning: scan all locations for at-risk SKUs and propose restock POs.',
    eventName: 'ops/restock.scheduled',
    event: MorningRestockTickSchema,
    normalize: (_raw, { eventId }) => ({ source: 'schedule' as const, eventId }),
  });
}

/**
 * App-level triggers (not owned by a connector): Slack interactivity (approval buttons) and the
 * morning schedule. Connector triggers (`distru.order_created`, `composio.gmail.new_message`) come
 * with their connectors.
 */
export function appTriggers(cron: string = env.RESTOCK_CRON): AnyTrigger[] {
  return [slackInteractionTrigger, morningRestockTrigger(cron)];
}
