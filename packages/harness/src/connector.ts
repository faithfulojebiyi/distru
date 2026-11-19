import { z } from 'zod';
import type { AnyAction, AnyReadTool } from './action';
import type { AnyTrigger } from './trigger';

/** The kind of business system a connector plugs into the harness. */
export const ConnectorSystemSchema = z.enum(['erp', 'crm', 'email', 'calendar', 'spreadsheet', 'analytics', 'compliance', 'other']);
export type ConnectorSystem = z.infer<typeof ConnectorSystemSchema>;

export const ConnectorHealthSchema = z.object({ ok: z.boolean(), detail: z.string().optional() });
export type ConnectorHealth = z.infer<typeof ConnectorHealthSchema>;

/** Connector id + system, attached to every tool a connector contributes (catalog, UI badges). */
export const ConnectorRefSchema = z.object({ id: z.string(), system: ConnectorSystemSchema });
export type ConnectorRef = z.infer<typeof ConnectorRefSchema>;

/**
 * The slice of app context a connector needs: its own client under `ctx.connectors[id]`.
 *
 * Contexts compose by intersection, so an app context that satisfies every connector is simply
 * `{ connectors: { distru: DistruClient; email: Mailer }; tenantId: string }`:
 *
 * ```ts
 * type DistruCtx = ConnectorContext<'distru', DistruClient>; // { connectors: { distru: DistruClient } }
 * type EmailCtx = ConnectorContext<'email', Mailer>;
 * const registry = Registry.fromConnectors([distruConnector, emailConnector]); // Registry<DistruCtx & EmailCtx>
 * ```
 */
export type ConnectorContext<TId extends string, TClient> = { connectors: { [K in TId]: TClient } };

/**
 * A system plugged into the harness: read tools + write actions sharing one id, system and context.
 * Names are connector-local (`velocity_report`, `purchases.upsert`); the registry namespaces them by
 * id (`distru.velocity_report` → tool `distru_velocity_report`, action `distru.purchases.upsert` →
 * tool `propose_distru_purchases_upsert`).
 */
export interface ConnectorDefinition<TCtx> {
  readonly kind: 'connector';
  readonly id: string;
  readonly system: ConnectorSystem;
  readonly description: string;
  readonly readTools: readonly AnyReadTool<TCtx>[];
  readonly actions: readonly AnyAction<TCtx>[];
  /**
   * Inbound events this system can start work with (signed webhooks, schedules). Ids must start with
   * `<connector id>.`; the registry stamps `connectorId`.
   */
  readonly triggers?: readonly AnyTrigger[];
  /** Cheap liveness/auth probe for the Settings / integrations page. */
  health?(ctx: TCtx): Promise<ConnectorHealth>;
  /**
   * Type-only marker (never set at runtime). Declared as a function *property* so it is checked
   * contravariantly: a `ConnectorDefinition<DistruCtx>` is usable where the app context `TApp` is
   * expected only if `TApp` provides everything `DistruCtx` needs.
   */
  readonly __context?: (ctx: TCtx) => void;
}

/** Any connector, whatever context it needs (for constraints). */
export type AnyConnector = ConnectorDefinition<never>;

/** The context a connector needs. */
export type ContextOf<C> = C extends ConnectorDefinition<infer TCtx> ? TCtx : never;

type UnionToIntersection<U> = (U extends unknown ? (u: U) => void : never) extends (i: infer I) => void ? I : never;

/** The app context that satisfies every connector in `Cs` (intersection of their contexts). */
export type ConnectorsContext<Cs extends readonly AnyConnector[]> = [Cs[number]] extends [never]
  ? unknown
  : UnionToIntersection<ContextOf<Cs[number]>>;

export type ConnectorSpec<TCtx> = Omit<ConnectorDefinition<TCtx>, 'kind' | '__context' | 'readTools' | 'actions' | 'triggers'> & {
  readTools?: readonly AnyReadTool<TCtx>[];
  actions?: readonly AnyAction<TCtx>[];
  triggers?: readonly AnyTrigger[];
};

const CONNECTOR_ID = /^[a-z][a-z0-9_]*$/;

/** Define a connector. Tool/action names stay connector-local; the registry adds the `<id>.` prefix. */
export function defineConnector<TCtx>(spec: ConnectorSpec<TCtx>): ConnectorDefinition<TCtx> {
  if (!CONNECTOR_ID.test(spec.id)) throw new Error(`Invalid connector id '${spec.id}' (expected e.g. 'distru')`);
  ConnectorSystemSchema.parse(spec.system);
  const triggers = (spec.triggers ?? []).map((t) => {
    if (!t.id.startsWith(`${spec.id}.`)) throw new Error(`Trigger '${t.id}' of connector '${spec.id}' must be namespaced '${spec.id}.<name>'`);
    if (t.connectorId && t.connectorId !== spec.id) throw new Error(`Trigger '${t.id}' already belongs to connector '${t.connectorId}'`);
    return { ...t, connectorId: spec.id };
  });
  return { ...spec, readTools: spec.readTools ?? [], actions: spec.actions ?? [], triggers, kind: 'connector' };
}

/** Fully-qualified registry name of a connector-local tool/action name. */
export const qualifiedName = (connectorId: string, name: string): string => `${connectorId}.${name}`;
