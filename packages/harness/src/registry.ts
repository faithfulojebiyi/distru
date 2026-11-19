import { z } from 'zod';
import type { ActionScope, AnyAction, AnyReadTool, Risk } from './action';
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
    }
  | {
      kind: 'read';
      name: string;
      toolName: string;
      description: string;
      requiredScope: 'read';
      inputSchema: JsonSchema;
      outputSchema?: JsonSchema;
    };

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

  constructor(init: { actions?: readonly AnyAction<TCtx>[]; readTools?: readonly AnyReadTool<TCtx>[] } = {}) {
    for (const action of init.actions ?? []) this.addAction(action);
    for (const tool of init.readTools ?? []) this.addReadTool(tool);
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
      }));
    return [...reads, ...actions];
  }

  #assertFree(name: string): void {
    if (this.#actions.has(name) || this.#readTools.has(name)) {
      throw new Error(`Duplicate action/tool name '${name}'`);
    }
  }
}
