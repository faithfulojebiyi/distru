/**
 * MCP tool `inputSchema` (JSON Schema) → zod, for the harness. Uses zod 4's `z.fromJSONSchema`;
 * a schema it cannot convert falls back to "any JSON object" (the MCP server still validates, and a
 * write still needs approval of the exact arguments).
 */
import { z } from 'zod';

export type JsonObject = Record<string, unknown>;

const isRecord = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

export const propertiesOf = (schema: JsonObject): JsonObject => (isRecord(schema.properties) ? schema.properties : {});
export const requiredOf = (schema: JsonObject): string[] => (Array.isArray(schema.required) ? schema.required.filter((x): x is string => typeof x === 'string') : []);

/** Values of `properties.action.enum` (Distru `mutate-*` tools: CREATE / UPDATE / DELETE). */
export function actionEnumOf(schema: JsonObject): string[] {
  const action = propertiesOf(schema).action;
  if (!isRecord(action)) return [];
  if (Array.isArray(action.enum)) return action.enum.filter((x): x is string => typeof x === 'string');
  if (typeof action.const === 'string') return [action.const];
  return [];
}

export interface PrepareOptions {
  /** Fields the bridge fills from run context: made optional for the agent. */
  injected?: readonly string[];
  /** Restrict `properties.action` to these values (DELETE split). */
  actionValues?: readonly string[];
}

/** Clone of the tool schema as the agent should see it. */
export function prepareSchema(schema: JsonObject, options: PrepareOptions = {}): JsonObject {
  const clone: JsonObject = structuredClone(schema);
  if (clone.type === undefined) clone.type = 'object';
  delete clone.$schema;
  const injected = new Set(options.injected ?? []);
  const required = requiredOf(clone).filter((r) => !injected.has(r));
  if (Array.isArray(clone.required)) clone.required = required;
  if (options.actionValues) {
    const props = { ...propertiesOf(clone) };
    const action: JsonObject = isRecord(props.action) ? { ...props.action } : { type: 'string' };
    delete action.const;
    action.enum = [...options.actionValues];
    props.action = action;
    clone.properties = props;
  }
  return clone;
}

export const AnyObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), z.unknown());

/** JSON Schema → zod object validator. Never throws: unconvertible schemas accept any object. */
export function toZod(schema: JsonObject): { schema: z.ZodType<JsonObject>; exact: boolean } {
  if (schema.type !== 'object') return { schema: AnyObjectSchema, exact: false };
  try {
    const converted = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
    // The registry renders `z.toJSONSchema(input)` into the tool catalog: make sure that works.
    z.toJSONSchema(converted, { io: 'input' });
    // Sound: the root is `type: object`, so a successful parse yields a JSON object.
    return { schema: converted as z.ZodType<JsonObject>, exact: true };
  } catch {
    return { schema: AnyObjectSchema, exact: false };
  }
}

/** Drop keys not declared in `properties` (unless the schema allows additional properties). */
export function stripUnknown(value: JsonObject, schema: JsonObject): JsonObject {
  const props = propertiesOf(schema);
  if (!Object.keys(props).length || schema.additionalProperties === true || isRecord(schema.additionalProperties)) return { ...value };
  return Object.fromEntries(Object.entries(value).filter(([k]) => k in props));
}
