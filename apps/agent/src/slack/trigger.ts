/**
 * Slack interactivity (button clicks on our approval messages) as a harness trigger
 * (`slack.interaction`).
 *
 * Slack signs every request: `x-slack-signature: v0=<hex HMAC-SHA256(signing secret, "v0:{ts}:{raw body}")>`
 * with `x-slack-request-timestamp: {ts}` (Unix seconds). We refuse timestamps more than five minutes
 * from now (replay window) and compare in constant time. The body is a form with one `payload` field
 * holding the JSON; we only handle `block_actions`. Events API deliveries to the same URL (JSON:
 * `url_verification`, `event_callback`) are verified and acknowledged (ignored; the route answers the
 * URL-verification challenge).
 */
import { createHash } from 'node:crypto';
import { defineTrigger, headerValue, hmacSha256Hex, timingSafeEqualString, type TriggerVerification } from '@ops/harness';
import { z } from 'zod';

export const SLACK_SIGNING_SECRET = 'SLACK_SIGNING_SECRET';
export const SLACK_INTERACTION_TRIGGER_ID = 'slack.interaction';
/** Max age (and future skew) of `x-slack-request-timestamp`, seconds. */
export const SLACK_TOLERANCE_SECONDS = 300;

/** `v0=` + hex HMAC of `v0:{timestamp}:{body}` (what Slack sends; tests sign with it). */
export async function slackSignature(secret: string, timestamp: number | string, body: string): Promise<string> {
  return `v0=${await hmacSha256Hex(secret, `v0:${timestamp}:${body}`)}`;
}

/** Verifies a Slack request signature over the raw body. Never throws. */
export async function verifySlackSignature(rawBody: string, headers: Parameters<typeof headerValue>[0], secret: string, now: Date, toleranceSeconds = SLACK_TOLERANCE_SECONDS): Promise<{ ok: true } | { ok: false; reason: string; message: string }> {
  const signature = headerValue(headers, 'x-slack-signature');
  const timestamp = headerValue(headers, 'x-slack-request-timestamp');
  if (!signature || !timestamp) return { ok: false, reason: 'missing_headers', message: 'x-slack-signature and x-slack-request-timestamp are required' };
  const ts = Number(timestamp);
  if (!Number.isInteger(ts)) return { ok: false, reason: 'bad_timestamp', message: 'x-slack-request-timestamp is not a Unix timestamp' };
  if (Math.abs(now.getTime() / 1000 - ts) > toleranceSeconds) return { ok: false, reason: 'stale_timestamp', message: `timestamp is more than ${toleranceSeconds}s from now` };
  const expected = await slackSignature(secret, ts, rawBody);
  if (!timingSafeEqualString(signature.trim(), expected)) return { ok: false, reason: 'bad_signature', message: 'x-slack-signature does not match the body' };
  return { ok: true };
}

const BlockActionsPayload = z.looseObject({
  type: z.literal('block_actions'),
  user: z.looseObject({ id: z.string(), username: z.string().optional(), name: z.string().optional() }),
  team: z.looseObject({ id: z.string() }).nullish(),
  channel: z.looseObject({ id: z.string(), name: z.string().optional() }).nullish(),
  container: z.looseObject({ message_ts: z.string().optional(), channel_id: z.string().optional() }).nullish(),
  message: z.looseObject({ ts: z.string().optional(), text: z.string().optional() }).nullish(),
  response_url: z.string().optional(),
  trigger_id: z.string().optional(),
  actions: z.array(z.looseObject({ action_id: z.string(), block_id: z.string().optional(), value: z.string().optional(), action_ts: z.string().optional() })).min(1),
});

export const SlackBlockActionsEventSchema = z
  .object({
    source: z.literal('slack'),
    type: z.literal('block_actions'),
    eventId: z.string(),
    user: z.object({ id: z.string(), username: z.string().nullable() }),
    teamId: z.string().nullable(),
    channelId: z.string().nullable(),
    messageTs: z.string().nullable(),
    actions: z.array(z.object({ actionId: z.string(), value: z.string().nullable(), blockId: z.string().nullable() })),
  })
  .meta({ id: 'SlackBlockActionsEvent' });
export type SlackBlockActionsEvent = z.infer<typeof SlackBlockActionsEventSchema>;

export const slackInteractionTrigger = defineTrigger<SlackBlockActionsEvent>({
  id: SLACK_INTERACTION_TRIGGER_ID,
  source: 'slack',
  description: 'A member clicked a button on one of our Slack messages (block_actions), e.g. Approve / Reject on an approval request.',
  eventName: 'slack/block_actions',
  event: SlackBlockActionsEventSchema,
  secret: SLACK_SIGNING_SECRET,
  verify: async (rawBody, headers, secrets, { now }): Promise<TriggerVerification> => {
    const sig = await verifySlackSignature(rawBody, headers, secrets[SLACK_SIGNING_SECRET] ?? '', now);
    if (!sig.ok) return sig;
    const digest = createHash('sha256').update(rawBody).digest('hex').slice(0, 24);
    // Events API deliveries (same request URL) are JSON: url_verification, event_callback (message.channels,
    // app_mention). Verified and acknowledged; `normalize` ignores them.
    if (rawBody.trimStart().startsWith('{')) {
      try {
        const raw: unknown = JSON.parse(rawBody);
        const eventId = z.looseObject({ event_id: z.string() }).safeParse(raw);
        return { ok: true, webhookId: eventId.success ? eventId.data.event_id : `event-${digest}`, raw };
      } catch {
        return { ok: false, reason: 'bad_payload', message: 'body is not JSON' };
      }
    }
    const field = new URLSearchParams(rawBody).get('payload');
    if (!field) return { ok: false, reason: 'bad_payload', message: 'form field `payload` is missing' };
    let raw: unknown;
    try {
      raw = JSON.parse(field);
    } catch {
      return { ok: false, reason: 'bad_payload', message: '`payload` is not JSON' };
    }
    // Slack sends no delivery id for interactions: one click = this exact signed body.
    return { ok: true, webhookId: `${headerValue(headers, 'x-slack-request-timestamp')}-${digest}`, raw };
  },
  normalize: (raw, { eventId }) => {
    const type = z.looseObject({ type: z.string() }).parse(raw).type;
    if (type !== 'block_actions') return null;
    const p = BlockActionsPayload.parse(raw);
    return {
      source: 'slack',
      type: 'block_actions',
      eventId,
      user: { id: p.user.id, username: p.user.username ?? p.user.name ?? null },
      teamId: p.team?.id ?? null,
      channelId: p.channel?.id ?? p.container?.channel_id ?? null,
      messageTs: p.container?.message_ts ?? p.message?.ts ?? null,
      actions: p.actions.map((a) => ({ actionId: a.action_id, value: a.value ?? null, blockId: a.block_id ?? null })),
    };
  },
});
