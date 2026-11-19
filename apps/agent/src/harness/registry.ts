import { Registry } from '@ops/harness';

/**
 * Context passed to every action hook. The typed Distru client (packages/distru-client) and the
 * tenant land here once that package is ready; until then actions are not registered.
 */
export interface AppCtx {
  /** Tenant / Distru account the action runs against. */
  tenantId: string;
}

export function createAppCtx(): AppCtx {
  return { tenantId: 'default' };
}

/**
 * The app's action registry: write actions (`purchases.upsert`, …) and read tools. Empty for now —
 * deciding on stored proposals doesn't need action definitions (only edits re-plan), executing does.
 */
export const appRegistry = new Registry<AppCtx>({ actions: [], readTools: [] });
