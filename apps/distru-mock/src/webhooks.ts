/**
 * Distru-shaped webhooks: `{ type, event, id, object, changes, occurred_datetime }`, POSTed as JSON
 * with `x-distru-signature: sha256=<hex HMAC-SHA256 of the raw body>`.
 * Retries a few times with backoff on non-2xx / network errors (Distru retries ~10x over 4h).
 */
import { createHmac } from 'node:crypto';
import type { Store } from './store';
import type { WebhookLogEntry } from './types';

export type WebhookType = 'ORDER' | 'PURCHASE';
export type WebhookEvent = 'CREATE' | 'UPDATE' | 'DELETE';

export interface WebhookConfig {
  url?: string;
  secret: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** retry delays in ms (attempts = delays.length + 1) */
  retryDelaysMs?: number[];
}

export function sign(rawBody: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

const NESTED = new Set(['items', 'charges', 'payments', 'tasks', 'invoices', 'returns']);

/** Top-level field diff, Distru style: `{ field: { before, after } }`. */
export function computeChanges<T extends object>(beforeObj: T | null, afterObj: T): Record<string, { before: unknown; after: unknown }> {
  if (!beforeObj) return {};
  const before = beforeObj as Record<string, unknown>;
  const after = afterObj as Record<string, unknown>;
  const out: Record<string, { before: unknown; after: unknown }> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (NESTED.has(k)) continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out[k] = { before: before[k] ?? null, after: after[k] ?? null };
  }
  return out;
}

export class WebhookDispatcher {
  /** in-flight deliveries (tests can await `idle()`) */
  private pending = new Set<Promise<void>>();
  constructor(
    private readonly store: () => Store,
    public config: WebhookConfig,
  ) {}

  emit(type: WebhookType, event: WebhookEvent, id: string, object: unknown, changes: Record<string, unknown> = {}): void {
    const url = this.config.url;
    if (!url) return;
    const payload = { changes: event === 'UPDATE' ? changes : {}, event, id, object: event === 'DELETE' ? null : object, occurred_datetime: new Date().toISOString(), type };
    const p = this.deliver(url, payload).finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  private async deliver(url: string, payload: { type: string; event: string; id: string; occurred_datetime: string }): Promise<void> {
    const raw = JSON.stringify(payload);
    const doFetch = this.config.fetch ?? ((u: string, i: RequestInit) => fetch(u, i));
    const delays = this.config.retryDelaysMs ?? [500, 2000, 5000];
    const entry: WebhookLogEntry = { type: payload.type, event: payload.event, id: payload.id, url, status: 'error', attempts: 0, occurred_datetime: payload.occurred_datetime };
    const log = this.store().webhookLog;
    log.push(entry);
    if (log.length > 100) log.splice(0, log.length - 100);
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      entry.attempts = attempt + 1;
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-distru-signature': sign(raw, this.config.secret), 'user-agent': 'Distru-Webhooks (mock)' },
          body: raw,
        });
        entry.status = res.status;
        delete entry.error;
        if (res.ok) return;
      } catch (e) {
        entry.status = 'error';
        entry.error = e instanceof Error ? e.message : String(e);
      }
      const delay = delays[attempt];
      if (delay !== undefined) await new Promise((r) => setTimeout(r, delay));
    }
    console.warn(`[distru-mock] webhook ${payload.type} ${payload.event} ${payload.id} → ${url} failed after ${entry.attempts} attempts`);
  }
}
