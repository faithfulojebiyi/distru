/**
 * Distru-shaped webhooks (docs/research/guides/webhooks.md):
 *
 * - payload `{ changes, event, id, object, occurred_datetime, type }`, POSTed as JSON with
 *   `x-distru-signature: sha256=<hex HMAC-SHA256 of the raw body>`;
 * - `object` is the record **as it is when the webhook is sent** (fetched through `resolve`), not a
 *   snapshot from when the change was committed; `null` on DELETE (or when the record is gone);
 * - `changes` lists the top-level fields of that edit (computed at commit time); `{}` on CREATE/DELETE;
 * - webhooks about the same record are delivered strictly in order: a later one waits until the
 *   earlier one is delivered or given up on; different records are independent;
 * - non-2xx / network errors are retried with increasing delays (Distru: ~10 attempts over ~4 hours;
 *   configurable so tests stay fast).
 */
import { createHmac } from 'node:crypto';
import type { Store } from './store';
import type { WebhookLogEntry } from './types';

export type WebhookType = 'ORDER' | 'PURCHASE' | 'PRODUCT' | 'PACKAGE' | 'INVOICE' | 'COMPANY' | 'ASSEMBLY' | 'RETURN';
export type WebhookEvent = 'CREATE' | 'UPDATE' | 'DELETE';

/** ~10 attempts over ~4 hours, like Distru. */
export const DISTRU_RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 1_200_000, 1_800_000, 3_600_000, 5_400_000];

export interface WebhookConfig {
  url?: string;
  secret: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** retry delays in ms (attempts = delays.length + 1); default DISTRU_RETRY_DELAYS_MS */
  retryDelaysMs?: number[];
}

/** Current API shape of a record (same as its GET endpoint), or null when it no longer exists. */
export type WebhookResolver = (type: WebhookType, id: string) => unknown;

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

interface Pending {
  type: WebhookType;
  event: WebhookEvent;
  id: string;
  changes: Record<string, unknown>;
  occurred_datetime: string;
}

export class WebhookDispatcher {
  /** per-record delivery chains (`TYPE:id` → tail promise) */
  private chains = new Map<string, Promise<void>>();
  private pending = new Set<Promise<void>>();
  constructor(
    private readonly store: () => Store,
    public config: WebhookConfig,
    private readonly resolve: WebhookResolver = () => null,
  ) {}

  emit(type: WebhookType, event: WebhookEvent, id: string, changes: Record<string, unknown> = {}): void {
    const url = this.config.url;
    if (!url) return;
    const item: Pending = { type, event, id, changes: event === 'UPDATE' ? changes : {}, occurred_datetime: new Date().toISOString() };
    const key = `${type}:${id}`;
    const prev = this.chains.get(key) ?? Promise.resolve();
    const p = prev.then(() => this.deliver(url, item));
    this.chains.set(key, p);
    const tracked = p.finally(() => {
      this.pending.delete(tracked);
      if (this.chains.get(key) === p) this.chains.delete(key);
    });
    this.pending.add(tracked);
  }

  /** Resolves once every queued delivery (incl. retries) has finished. */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  private async deliver(url: string, item: Pending): Promise<void> {
    const doFetch = this.config.fetch ?? ((u: string, i: RequestInit) => fetch(u, i));
    const delays = this.config.retryDelaysMs ?? DISTRU_RETRY_DELAYS_MS;
    const entry: WebhookLogEntry = { type: item.type, event: item.event, id: item.id, url, status: 'error', attempts: 0, occurred_datetime: item.occurred_datetime };
    const log = this.store().webhookLog;
    log.push(entry);
    if (log.length > 200) log.splice(0, log.length - 200);
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      entry.attempts = attempt + 1;
      // object is fetched fresh at send time (retries included)
      const object = item.event === 'DELETE' ? null : (this.resolve(item.type, item.id) ?? null);
      const raw = JSON.stringify({ changes: item.changes, event: item.event, id: item.id, object, occurred_datetime: item.occurred_datetime, type: item.type });
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
    console.warn(`[distru-mock] webhook ${item.type} ${item.event} ${item.id} → ${url} given up after ${entry.attempts} attempts`);
  }
}
