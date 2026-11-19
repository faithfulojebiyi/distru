import { z } from 'zod';
import type { ActionScope, AnyAction, AnyReadTool, Risk } from './action';
import {
  qualifiedName,
  type AnyConnector,
  type ConnectorDefinition,
  type ConnectorHealth,
  type ConnectorRef,
  type ConnectorsContext,
  type ConnectorSystem,
} from './connector';
import { InputValidationError, NotFoundError } from './errors';
import { assertScope, hasScope, type Principal, type Scope } from './scopes';

export type JsonSchema = z.core.JSONSchema.BaseSchema;

/** Everything an adapter (Mastra tool factory, MCP server) needs to expose a tool. */
export type ToolDescriptor =
  | {
      kind: 'action';
      name: string;
      /** Safe tool name (`propose_purchases_upsert`): agents only ever *propose* writes. */
      toolName: string;
      description: string;
      resource: string;
      risk: Risk;
      requiredScope: ActionScope;
      inputSchema: JsonSchema;
      /** Set when the action was contributed by a connector. */
      connector?: ConnectorRef;
    }
  | {
      kind: 'read';
      name: string;
      toolName: string;
      description: string;
      requiredScope: 'read';
      inputSchema: JsonSchema;
      outputSchema?: JsonSchema;
      /** Set when the tool was contributed by a connector. */
      connector?: ConnectorRef;
    };

export interface ConnectorInfo extends ConnectorRef {
  description: string;
  /** Registry names (namespaced, e.g. `distru.velocity_report`). */
  readTools: string[];
  actions: string[];
}

export interface ConnectorHealthReport extends ConnectorHealth {
  id: string;
  system: ConnectorSystem;
}

export interface RegistryInit<TCtx> {
  actions?: readonly AnyAction<TCtx>[];
  readTools?: readonly AnyReadTool<TCtx>[];
  /** Connectors whose tools/actions are added under `<connector id>.<name>`. */
  connectors?: readonly ConnectorDefinition<TCtx>[];
}

export const toolNameFor = (kind: 'action' | 'read', name: string): string =>
  `${kind === 'action' ? 'propose_' : ''}${name.replaceAll('.', '_')}`;

export function parseWith<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new InputValidationError(`Invalid ${what}: ${z.prettifyError(result.error)}`, result.error.issues);
  }
  return result.data;
}

export class Registry<TCtx> {
  readonly #actions = new Map<string, AnyAction<TCtx>>();
  readonly #readTools = new Map<string, AnyReadTool<TCtx>>();
  readonly #connectors = new Map<string, ConnectorDefinition<TCtx>>();
  /** Registry name → contributing connector. */
  readonly #owner = new Map<string, ConnectorRef>();

  constructor(init: RegistryInit<TCtx> = {}) {
    for (const action of init.actions ?? []) this.addAction(action);
    for (const tool of init.readTools ?? []) this.addReadTool(tool);
    for (const connector of init.connectors ?? []) this.addConnector(connector);
  }

  /**
   * Registry typed with the intersection of the connectors' contexts, so the app must supply a
   * ctx satisfying all of them (e.g. `{ connectors: { distru, email } }`).
   */
  static fromConnectors<const Cs extends readonly AnyConnector[]>(connectors: Cs): Registry<ConnectorsContext<Cs>> {
    const registry = new Registry<ConnectorsContext<Cs>>();
    // Sound by construction: ConnectorsContext<Cs> is a subtype of every connector's context,
    // which TypeScript cannot see through the generic tuple, hence the widening cast.
    for (const c of connectors) registry.addConnector(c as unknown as ConnectorDefinition<ConnectorsContext<Cs>>);
    return registry;
  }

  /** Add a connector: its tools/actions are registered as `<id>.<name>` and tagged with id/system. */
  addConnector(connector: ConnectorDefinition<TCtx>): this {
    if (this.#connectors.has(connector.id)) throw new Error(`Duplicate connector '${connector.id}'`);
    const ref: ConnectorRef = { id: connector.id, system: connector.system };
    const tools = connector.readTools.map((t) => ({ ...t, name: qualifiedName(connector.id, t.name) }));
    const actions = connector.actions.map((a) => ({ ...a, name: qualifiedName(connector.id, a.name) }));
    for (const item of [...tools, ...actions]) this.#assertFree(item.name);
    for (const tool of tools) this.addReadTool(tool);
    for (const action of actions) this.addAction(action);
    for (const item of [...tools, ...actions]) this.#owner.set(item.name, ref);
    this.#connectors.set(connector.id, connector);
    return this;
  }

  connectors(): ConnectorInfo[] {
    return [...this.#connectors.values()].map((c) => ({
      id: c.id,
      system: c.system,
      description: c.description,
      readTools: c.readTools.map((t) => qualifiedName(c.id, t.name)),
      actions: c.actions.map((a) => qualifiedName(c.id, a.name)),
    }));
  }

  /** The connector that contributed a registry name, if any. */
  connectorOf(name: string): ConnectorRef | undefined {
    return this.#owner.get(name);
  }

  /** Runs every connector's `health` probe; a throwing probe is reported as not ok. */
  async health(ctx: TCtx): Promise<ConnectorHealthReport[]> {
    return Promise.all(
      [...this.#connectors.values()].map(async (c): Promise<ConnectorHealthReport> => {
        if (!c.health) return { id: c.id, system: c.system, ok: true, detail: 'no health check' };
        try {
          const h = await c.health(ctx);
          return { id: c.id, system: c.system, ...h };
        } catch (err) {
          return { id: c.id, system: c.system, ok: false, detail: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
  }

  addAction(action: AnyAction<TCtx>): this {
    this.#assertFree(action.name);
    this.#actions.set(action.name, action);
    return this;
  }

  addReadTool(tool: AnyReadTool<TCtx>): this {
    this.#assertFree(tool.name);
    this.#readTools.set(tool.name, tool);
    return this;
  }

  action(name: string): AnyAction<TCtx> {
    const action = this.#actions.get(name);
    if (!action) throw new NotFoundError(`Unknown action '${name}'`);
    return action;
  }

  readTool(name: string): AnyReadTool<TCtx> {
    const tool = this.#readTools.get(name);
    if (!tool) throw new NotFoundError(`Unknown read tool '${name}'`);
    return tool;
  }

  actions(): AnyAction<TCtx>[] {
    return [...this.#actions.values()];
  }

  readTools(): AnyReadTool<TCtx>[] {
    return [...this.#readTools.values()];
  }

  /** Run a read tool with scope enforcement and input (and optional output) validation. */
  async runReadTool(ctx: TCtx, principal: Principal, name: string, rawInput: unknown): Promise<unknown> {
    const tool = this.readTool(name);
    assertScope(principal, tool.requiredScope);
    const input = parseWith(tool.input, rawInput, `input for ${name}`);
    const output = await tool.run(ctx, input);
    return tool.output ? tool.output.parse(output) : output;
  }

  /** Tool catalog with JSON Schemas, optionally filtered to what `principal` may call. */
  catalog(principal?: Principal): ToolDescriptor[] {
    const allowed = (scope: Scope) => !principal || hasScope(principal, scope);
    const reads = this.readTools()
      .filter((t) => allowed(t.requiredScope))
      .map((t): ToolDescriptor => ({
        kind: 'read',
        name: t.name,
        toolName: toolNameFor('read', t.name),
        description: t.description,
        requiredScope: 'read',
        inputSchema: z.toJSONSchema(t.input, { io: 'input' }),
        ...(t.output ? { outputSchema: z.toJSONSchema(t.output) } : {}),
        ...this.#connectorField(t.name),
      }));
    const actions = this.actions()
      .filter((a) => allowed(a.requiredScope))
      .map((a): ToolDescriptor => ({
        kind: 'action',
        name: a.name,
        toolName: toolNameFor('action', a.name),
        description: a.description,
        resource: a.resource,
        risk: a.risk,
        requiredScope: a.requiredScope,
        inputSchema: z.toJSONSchema(a.input, { io: 'input' }),
        ...this.#connectorField(a.name),
      }));
    return [...reads, ...actions];
  }

  #connectorField(name: string): { connector?: ConnectorRef } {
    const ref = this.#owner.get(name);
    return ref ? { connector: { ...ref } } : {};
  }

  #assertFree(name: string): void {
    if (this.#actions.has(name) || this.#readTools.has(name)) {
      throw new Error(`Duplicate action/tool name '${name}'`);
    }
  }
}
