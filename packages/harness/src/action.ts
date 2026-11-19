import { z } from 'zod';
import { diff, type FieldChange } from './diff';
import type { VerifyResult } from './verify';

export const RiskSchema = z.enum(['low', 'medium', 'high']);
export type Risk = z.infer<typeof RiskSchema>;

/** Scopes that can gate a write action. Read is never enough to propose. */
export type ActionScope = 'propose' | 'approve';

export interface WrittenRecord<TRecord> {
  recordId: string;
  record: TRecord;
}

/**
 * A write action. Hooks are declared with method syntax on purpose: it lets a registry hold
 * actions with different input/payload/record types as `AnyAction<TCtx>` without `any`.
 *
 * - `TCtx`: app context passed to every hook (API client, tenant, logger…)
 * - `TInput`: what the agent/user supplies (validated by `input`)
 * - `TPayload`: the exact request body that will be sent to the ERP
 * - `TRecord`: the ERP record shape read back
 */
export interface ActionDefinition<TCtx, TInput, TPayload, TRecord> {
  readonly kind: 'action';
  readonly name: string;
  readonly resource: string;
  readonly description: string;
  readonly risk: Risk;
  readonly requiredScope: ActionScope;
  readonly input: z.ZodType<TInput>;
  /** Optional schema re-checked against the stored payload right before execution. */
  readonly payload?: z.ZodType<TPayload>;

  loadBefore(ctx: TCtx, input: TInput): Promise<TRecord | null>;
  plan(ctx: TCtx, input: TInput, before: TRecord | null): Promise<TPayload> | TPayload;
  diff(before: TRecord | null, payload: TPayload): FieldChange[];
  execute(ctx: TCtx, payload: TPayload, idempotencyKey: string): Promise<WrittenRecord<TRecord>>;
  verify(ctx: TCtx, recordId: string, expected: TPayload): Promise<VerifyResult>;
  /** Lookup of a record previously written with this key (Distru: key stamped into notes/custom field). */
  findByIdempotencyKey(ctx: TCtx, idempotencyKey: string): Promise<WrittenRecord<TRecord> | null>;

  /** Monetary value of the payload, used by value-based policy rules. */
  valueOf?(payload: TPayload): number;
  /** Vendor ids referenced by the payload, used by the vendor allowlist rule. */
  vendorIdsOf?(payload: TPayload): string[];
  /**
   * One-line human summary for inboxes ("PO for 120 × Blue Dream 3.5g from Acme"). May be async
   * and may use `ctx` / `before` (e.g. to resolve a vendor name); called at propose and edit time.
   */
  summarize?(input: TInput, payload: TPayload, ctx: TCtx, before: TRecord | null): string | Promise<string>;
}

/** Type-erased action, as stored in a registry. */
export type AnyAction<TCtx> = ActionDefinition<TCtx, unknown, unknown, unknown>;

export type ActionSpec<TCtx, TInput, TPayload, TRecord> = Omit<
  ActionDefinition<TCtx, TInput, TPayload, TRecord>,
  'kind' | 'requiredScope' | 'diff'
> & {
  requiredScope?: ActionScope;
  diff?(before: TRecord | null, payload: TPayload): FieldChange[];
};

const NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

function assertName(name: string): void {
  if (!NAME.test(name)) throw new Error(`Invalid action/tool name '${name}' (expected e.g. 'purchases.upsert')`);
}

/**
 * Define a write action. Defaults: `requiredScope: 'propose'`, and a sparse structural `diff` of
 * the current record against the payload.
 */
export function defineAction<TCtx, TInput, TPayload, TRecord>(
  spec: ActionSpec<TCtx, TInput, TPayload, TRecord>,
): ActionDefinition<TCtx, TInput, TPayload, TRecord> {
  assertName(spec.name);
  return {
    diff: (before, payload) => diff(before, payload),
    ...spec,
    kind: 'action',
    requiredScope: spec.requiredScope ?? 'propose',
  };
}

/** A side-effect-free read tool. Always requires the `read` scope. */
export interface ReadToolDefinition<TCtx, TInput, TOutput> {
  readonly kind: 'read';
  readonly name: string;
  readonly description: string;
  readonly requiredScope: 'read';
  readonly input: z.ZodType<TInput>;
  readonly output?: z.ZodType<TOutput>;
  run(ctx: TCtx, input: TInput): Promise<TOutput>;
}

export type AnyReadTool<TCtx> = ReadToolDefinition<TCtx, unknown, unknown>;

export function defineReadTool<TCtx, TInput, TOutput>(
  spec: Omit<ReadToolDefinition<TCtx, TInput, TOutput>, 'kind' | 'requiredScope'>,
): ReadToolDefinition<TCtx, TInput, TOutput> {
  assertName(spec.name);
  return { ...spec, kind: 'read', requiredScope: 'read' };
}
