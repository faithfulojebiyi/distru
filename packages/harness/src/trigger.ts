import { z } from 'zod';
import type { AuditSink, Clock, IdGenerator } from './ports';
import { randomId, systemClock } from './runtime';
import { NotFoundError } from './errors';
import type { SystemActor } from './scopes';

/**
 * Triggers: how the outside world starts agent work. A trigger is the inbound counterpart of an
 * action: a signed webhook (Distru ORDER CREATE, a Composio Gmail message, a Slack button click) or a
 * schedule (the morning restock scan). Like actions, triggers are data the registry holds, so the app,
 * the UI and the audit trail all see the same catalogue.
 *
 * A webhook trigger owns its **verification** (signature over the raw body, never the parsed one) and
 * **normalization** into a zod-validated event. `ingestWebhook` runs both, audits the outcome
 * (`trigger.received` / `trigger.rejected`) and returns the event ready for a durable queue
 * (`{ name, id, data }`, with `id` derived from the provider's event id so a redelivery dedupes).
 */

/** Request headers as a fetch `Headers` or a plain record (Node-style, possibly multi-valued). */
export type HeaderBag = Headers | Readonly<Record<string, string | readonly string[] | undefined>>;

/** Case-insensitive header lookup over either header shape. */
export function headerValue(headers: HeaderBag, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const lower = name.toLowerCase();
  const found = Object.entries(headers).find(([k]) => k.toLowerCase() === lower)?.[1];
  return typeof found === 'string' ? found : found?.[0];
}

/** Secrets by name (e.g. `{ COMPOSIO_WEBHOOK_SECRET: '…' }`); each trigger reads the one it declares. */
export type TriggerSecrets = Readonly<Record<string, string | undefined>>;

export type TriggerVerification =
  | {
      ok: true;
      /** The provider's unique event/delivery id (stable across redeliveries): the dedupe key. */
      webhookId: string;
      /** The verified payload, parsed (what `normalize` receives). */
      raw: unknown;
    }
  | { ok: false; reason: string; message?: string };

export interface TriggerVerifyContext {
  /** For timestamp tolerance checks (the harness clock, so tests can pin it). */
  now: Date;
}

export interface NormalizeContext {
  /** `webhookId` from verification (or a schedule tick id). */
  eventId: string;
}

export const TriggerSourceSchema = z.string().min(1).regex(/^[a-z][a-z0-9_-]*$/);

interface TriggerBase<TEvent> {
  readonly kind: 'trigger';
  /** Globally unique, namespaced id (`composio.gmail.new_message`, `distru.order_created`). */
  readonly id: string;
  /** Who sends it: `composio`, `distru`, `slack`, `schedule`, … */
  readonly source: string;
  /** The connector that contributed it (set by the registry for connector triggers). */
  readonly connectorId?: string;
  readonly description: string;
  /** Event name the app emits on its queue (Inngest), e.g. `composio/gmail.new_message`. */
  readonly eventName: string;
  /** The normalized event's schema; `ingestWebhook` validates every event with it. */
  readonly event: z.ZodType<TEvent>;
  /**
   * Dotted paths in the event that carry external free text (wrapped as untrusted). Recorded on the
   * `trigger.received` audit event and shown in the catalogue, so reviewers know what not to trust.
   */
  readonly untrustedFields?: readonly string[];
}

export interface WebhookTriggerDefinition<TEvent> extends TriggerBase<TEvent> {
  readonly delivery: 'webhook';
  /** Name of the secret in `TriggerSecrets` that `verify` needs (documentation + a clear error when missing). */
  readonly secret?: string;
  /** Verify the signature over the **raw** body. Must never throw for a bad request (return `ok: false`). */
  verify(rawBody: string, headers: HeaderBag, secrets: TriggerSecrets, context: TriggerVerifyContext): TriggerVerification | Promise<TriggerVerification>;
  /** Verified payload → event, or null when this trigger does not handle it (acknowledged, ignored). May throw on a malformed payload. */
  normalize(raw: unknown, context: NormalizeContext): TEvent | null;
}

export interface ScheduleTriggerDefinition<TEvent> extends TriggerBase<TEvent> {
  readonly delivery: 'schedule';
  /** Cron expression for the queue (Inngest supports a `TZ=` prefix). */
  readonly cron: string;
  /** The event a tick produces. */
  normalize(raw: unknown, context: NormalizeContext): TEvent | null;
}

export type TriggerDefinition<TEvent> = WebhookTriggerDefinition<TEvent> | ScheduleTriggerDefinition<TEvent>;
/** Any trigger (for registries and lists). */
export type AnyTrigger = TriggerDefinition<unknown>;

type WebhookSpec<TEvent> = Omit<WebhookTriggerDefinition<TEvent>, 'kind' | 'delivery'> & { delivery?: 'webhook' };
type ScheduleSpec<TEvent> = Omit<ScheduleTriggerDefinition<TEvent>, 'kind'>;
export type TriggerSpec<TEvent> = WebhookSpec<TEvent> | ScheduleSpec<TEvent>;

const TRIGGER_ID = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

/**
 * Define a trigger. Webhook triggers (the default) need `verify` + `normalize`; schedule triggers
 * (`delivery: 'schedule'`) need `cron` + `normalize`. Ids are namespaced (`<source or connector>.<name>`).
 */
export function defineTrigger<TEvent>(spec: WebhookSpec<TEvent>): WebhookTriggerDefinition<TEvent>;
export function defineTrigger<TEvent>(spec: ScheduleSpec<TEvent>): ScheduleTriggerDefinition<TEvent>;
export function defineTrigger<TEvent>(spec: TriggerSpec<TEvent>): TriggerDefinition<TEvent> {
  if (!TRIGGER_ID.test(spec.id)) throw new Error(`Invalid trigger id '${spec.id}' (expected a namespaced id such as 'composio.gmail.new_message')`);
  TriggerSourceSchema.parse(spec.source);
  if (!spec.eventName) throw new Error(`Trigger '${spec.id}' needs an eventName`);
  if (spec.delivery === 'schedule') {
    if (!spec.cron.trim()) throw new Error(`Schedule trigger '${spec.id}' needs a cron expression`);
    return { ...spec, kind: 'trigger' };
  }
  return { ...spec, delivery: 'webhook', kind: 'trigger' };
}

/** Catalogue entry for the UI / API. */
export interface TriggerInfo {
  id: string;
  source: string;
  delivery: 'webhook' | 'schedule';
  connectorId: string | null;
  description: string;
  eventName: string;
  cron: string | null;
  secret: string | null;
  untrustedFields: string[];
}

export function triggerInfo(t: AnyTrigger): TriggerInfo {
  return {
    id: t.id,
    source: t.source,
    delivery: t.delivery,
    connectorId: t.connectorId ?? null,
    description: t.description,
    eventName: t.eventName,
    cron: t.delivery === 'schedule' ? t.cron : null,
    secret: t.delivery === 'webhook' ? (t.secret ?? null) : null,
    untrustedFields: [...(t.untrustedFields ?? [])],
  };
}

/** Anything that can resolve a trigger by id (the `Registry`, or `triggerSource([...])`). */
export interface TriggerSource {
  trigger(id: string): AnyTrigger;
}

/** A `TriggerSource` over a plain list (e.g. one route that only knows its own trigger). */
export function triggerSource(triggers: readonly AnyTrigger[]): TriggerSource {
  const byId = new Map(triggers.map((t) => [t.id, t]));
  return {
    trigger(id) {
      const t = byId.get(id);
      if (!t) throw new NotFoundError(`Unknown trigger '${id}'`);
      return t;
    },
  };
}

/** The queue event a trigger produces: `id` dedupes redeliveries (Inngest keeps ids for 24 h). */
export interface TriggerEvent<TData = unknown> {
  name: string;
  id: string;
  data: TData;
}

export type IngestResult =
  | { status: 'accepted'; triggerId: string; webhookId: string; event: TriggerEvent }
  /** Verified, but `normalize` returned null: acknowledge (2xx) and do nothing. */
  | { status: 'ignored'; triggerId: string; webhookId: string; reason: string }
  /** Signature/payload rejected: `httpStatus` 401 (signature, headers, timestamp) or 400 (payload). */
  | { status: 'rejected'; triggerId: string; reason: string; message: string; httpStatus: 400 | 401 };

export interface IngestOptions {
  audit: AuditSink;
  clock?: Clock;
  ids?: IdGenerator;
}

const actorFor = (t: AnyTrigger): SystemActor => ({ kind: 'system', id: `trigger:${t.id}`, label: `${t.source} trigger` });
const errorMessage = (err: unknown) => (err instanceof z.ZodError ? z.prettifyError(err) : err instanceof Error ? err.message : String(err));
const PAYLOAD_REASONS = new Set(['bad_payload', 'invalid_body', 'unsupported_payload']);

/**
 * Verify → normalize → validate → audit one webhook delivery. Never throws for a bad request (only
 * for an unknown trigger id, `NotFoundError`, or a schedule trigger). Pass the **raw** body.
 *
 * - bad signature / headers / timestamp → `rejected` (401) + `trigger.rejected`
 * - malformed payload (normalize throws, or the event fails the trigger's schema) → `rejected` (400) + `trigger.rejected`
 * - verified but not handled (`normalize` → null) → `ignored` + `trigger.received { ignored: true }`
 * - otherwise → `accepted` with `{ name: eventName, id: '<trigger id>:<webhook id>', data }` + `trigger.received`
 */
export async function ingestWebhook(
  source: TriggerSource,
  triggerId: string,
  rawBody: string,
  headers: HeaderBag,
  secrets: TriggerSecrets,
  options: IngestOptions,
): Promise<IngestResult> {
  const trigger = source.trigger(triggerId);
  if (trigger.delivery !== 'webhook') throw new Error(`Trigger '${triggerId}' is a ${trigger.delivery} trigger, not a webhook`);
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? randomId;
  const actor = actorFor(trigger);
  const base = { actor, proposalId: null };
  const audit = (event: Parameters<AuditSink['append']>[0]) => options.audit.append(event);
  const stamp = () => ({ id: ids(), at: clock.now().toISOString() });

  const reject = async (reason: string, message: string, httpStatus: 400 | 401): Promise<IngestResult> => {
    await audit({ ...stamp(), ...base, type: 'trigger.rejected', data: { triggerId: trigger.id, source: trigger.source, connectorId: trigger.connectorId ?? null, reason, message: message.slice(0, 500) } });
    return { status: 'rejected', triggerId: trigger.id, reason, message, httpStatus };
  };

  if (trigger.secret && !secrets[trigger.secret]) return reject('missing_secret', `${trigger.secret} is not configured`, 401);

  let verified: TriggerVerification;
  try {
    verified = await trigger.verify(rawBody, headers, secrets, { now: clock.now() });
  } catch (err) {
    verified = { ok: false, reason: 'bad_signature', message: errorMessage(err) };
  }
  if (!verified.ok) return reject(verified.reason, verified.message ?? verified.reason, PAYLOAD_REASONS.has(verified.reason) ? 400 : 401);

  let data: unknown;
  try {
    const normalized = trigger.normalize(verified.raw, { eventId: verified.webhookId });
    data = normalized === null ? null : trigger.event.parse(normalized);
  } catch (err) {
    return reject('bad_payload', errorMessage(err), 400);
  }

  const received = {
    triggerId: trigger.id,
    source: trigger.source,
    connectorId: trigger.connectorId ?? null,
    eventName: trigger.eventName,
    webhookId: verified.webhookId,
    untrustedFields: [...(trigger.untrustedFields ?? [])],
  };
  if (data === null) {
    await audit({ ...stamp(), ...base, type: 'trigger.received', data: { ...received, ignored: true } });
    return { status: 'ignored', triggerId: trigger.id, webhookId: verified.webhookId, reason: `${trigger.id}: payload not handled by this trigger` };
  }
  await audit({ ...stamp(), ...base, type: 'trigger.received', data: { ...received, ignored: false } });
  return { status: 'accepted', triggerId: trigger.id, webhookId: verified.webhookId, event: { name: trigger.eventName, id: `${trigger.id}:${verified.webhookId}`, data } };
}

/** HMAC-SHA256 (Web Crypto) as lowercase hex, for triggers that verify provider signatures. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison (for signatures). */
export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
