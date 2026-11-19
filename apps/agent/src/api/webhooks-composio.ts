/**
 * POST /api/webhooks/composio: Composio trigger webhooks (Standard Webhooks signature over the raw body).
 *
 *   raw body → ingestWebhook(`composio.gmail.new_message`) → 401 forged / 400 malformed / 200 ignored
 *   → inngest.send({ name: 'composio/gmail.new_message', id: '<trigger id>:<webhook-id>', data })
 *
 * The Inngest event id makes a redelivered webhook a no-op (Inngest dedupes ids for 24 h); the
 * `vendor-reply-on-email` function starts the vendor-reply workflow from the event.
 */
import { composioGmailNewMessageTrigger } from '@ops/connector-composio';
import { ingestWebhook, NotFoundError, triggerSource, type AnyTrigger, type AuditSink, type Clock, type TriggerEvent, type TriggerSource } from '@ops/harness';
import { Hono } from 'hono';
import { rawBodyOf } from './webhook-support';

export const COMPOSIO_WEBHOOK_PATH = '/api/webhooks/composio';

export interface ComposioWebhookDeps {
  /** The app registry (holds the connector's trigger once Composio is connected). */
  triggers: () => TriggerSource;
  audit: AuditSink;
  clock?: Clock;
  secret: string;
  /** Connector id the trigger is namespaced with (default `composio`). */
  connectorId?: string;
  /** Queue the event (Inngest `send`); must dedupe by `event.id`. */
  send: (event: TriggerEvent) => Promise<void>;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export function createComposioWebhookRoutes(deps: ComposioWebhookDeps) {
  const app = new Hono();
  const connectorId = deps.connectorId ?? 'composio';
  const triggerId = `${connectorId}.gmail.new_message`;
  // Verification does not need a live Composio connection: fall back to the static trigger while the
  // connector is down (degraded mode), so replies are still accepted and queued.
  const fallback = triggerSource([composioGmailNewMessageTrigger(connectorId) as AnyTrigger]);
  const source = (): TriggerSource => {
    const registry = deps.triggers();
    try {
      registry.trigger(triggerId);
      return registry;
    } catch (err) {
      if (err instanceof NotFoundError) return fallback;
      throw err;
    }
  };

  app.post(COMPOSIO_WEBHOOK_PATH, async (c) => {
    const raw = await rawBodyOf(c.req.raw);
    const result = await ingestWebhook(source(), triggerId, raw, c.req.raw.headers, { COMPOSIO_WEBHOOK_SECRET: deps.secret }, { audit: deps.audit, ...(deps.clock ? { clock: deps.clock } : {}) });
    if (result.status === 'rejected') {
      deps.log?.('composio webhook rejected', { reason: result.reason });
      return c.json({ error: result.reason, message: result.message }, result.httpStatus);
    }
    if (result.status === 'ignored') return c.json({ ok: true, action: 'ignored', webhookId: result.webhookId });
    await deps.send(result.event);
    return c.json({ ok: true, action: 'queued', event: { name: result.event.name, id: result.event.id } });
  });

  return app;
}
