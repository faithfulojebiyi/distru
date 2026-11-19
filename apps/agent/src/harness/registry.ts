import { createDistruContext, distruConnector, type DistruCtx } from '@ops/connector-distru';
import type { FetchLike } from '@ops/distru-client';
import { Registry } from '@ops/harness';
import { env } from '../env';

/**
 * The app's action registry: every connector's read tools and write actions, namespaced by
 * connector id (`distru.velocity_report` → tool `distru_velocity_report`, `distru.purchases.upsert`
 * → tool `propose_distru_purchases_upsert`). Typed with the intersection of the connectors' contexts.
 */
export const appRegistry = Registry.fromConnectors([distruConnector]);

/** What the registry's hooks need (`ctx.connectors.distru`), plus the tenant this process serves. */
export type AppCtx = DistruCtx & { tenantId: string };

export interface AppContexts {
  /** Reads and planning (propose/edit): the Distru client retries 429/5xx itself. */
  read: AppCtx;
  /**
   * `harness.execute`: `maxRetries: 0`, so a 429/5xx reaches the harness, which retries with
   * `distruErrorClassifier` (honouring Retry-After) and audits each attempt (`op.retry`).
   */
  execute: AppCtx;
}

export interface AppContextConfig {
  baseUrl: string;
  token: string;
  tenantId?: string;
  /** Injected in tests (e.g. the in-process Distru mock). */
  fetch?: FetchLike;
}

export function buildAppContexts(config: AppContextConfig): AppContexts {
  const { baseUrl, token, fetch } = config;
  const tenantId = config.tenantId ?? 'default';
  const base = { baseUrl, token, ...(fetch ? { fetch } : {}) };
  return {
    read: { ...createDistruContext(base), tenantId },
    execute: { ...createDistruContext({ ...base, maxRetries: 0 }), tenantId },
  };
}

let contexts: AppContexts | null = null;

/** Process-wide contexts from DISTRU_BASE_URL / DISTRU_API_TOKEN (the local mock by default). */
export function appContexts(): AppContexts {
  contexts ??= buildAppContexts({ baseUrl: env.DISTRU_BASE_URL, token: env.DISTRU_API_TOKEN });
  return contexts;
}

/** Context for reads, propose and decide (edits re-plan). */
export function createAppCtx(): AppCtx {
  return appContexts().read;
}
