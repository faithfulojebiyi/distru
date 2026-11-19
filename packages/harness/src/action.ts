import { z } from 'zod';
import { diff, type FieldChange } from './diff';
import type { OpResult, ProposalOp } from './proposal';
import type { OutputValue } from './refs';
import type { VerifyResult } from './verify';

export const RiskSchema = z.enum(['low', 'medium', 'high']);
export type Risk = z.infer<typeof RiskSchema>;

/** Scopes that can gate a write action. Read is never enough to propose. */
export type ActionScope = 'propose' | 'approve';

export interface WrittenRecord<TRecord> {
  recordId: string;
  record: TRecord;
}

/** Whether one executed op can be compensated (undone), and if not, why (shown to the approver). */
export type CompensationCheck = { ok: true } | { ok: false; reason: string };

/**
 * An executed op as compensation hooks see it. `input` and `payload` have op references
 * (`{{op:N.field}}`) already resolved from the original proposal, so they hold the real values.
 */
export type CompensableOp = Pick<ProposalOp, 'index' | 'action' | 'resource' | 'input' | 'before' | 'payload' | 'diff'>;

/**
 * The compensating change for one op, planned when the undo is proposed: the record as it is now
 * (`current`) and the sparse target state (`target`; `null` = the record will be deleted). Drives
 * the diff the approver sees and the read-after-write check after the undo runs.
 */
export interface CompensationPlan {
  current: unknown;
  target: unknown;
  /** One-line summary for the undo proposal ("Delete PO-1042 (PENDING, never received)"). */
  summary?: string;
  /** Policy value of the compensating write (0 for a delete/cancel). Unset = 0 for moneyless actions, else unknown. */
  value?: number | null;
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

  /** Monetary value of the payload, used by value-based policy rules (null = unknown). */
  valueOf?(payload: TPayload): number | null;
  /**
   * The action never moves money (an email, a task, a catalog setting): its ops count as 0 toward
   * value rules instead of making the proposal total unknown. Without it, an op with no `valueOf`
   * has value `null`, so `max_total_value` cannot be checked and asks for a human (fail closed).
   */
  readonly moneyless?: boolean;
  /** Vendor ids referenced by the payload, used by the vendor allowlist rule. */
  vendorIdsOf?(payload: TPayload): string[];
  /**
   * Values of the written record that later ops in the same proposal may reference as
   * `{{op:<index>.<key>}}` (e.g. `{ purchase_number: 'PO-1042' }`). Recorded in the op result.
   * The record id is always available as `{{op:<index>.recordId}}`.
   */
  outputs?(record: TRecord, recordId: string): Record<string, OutputValue>;
  /**
   * One-line human summary for inboxes ("PO for 120 × Blue Dream 3.5g from Acme"). May be async
   * and may use `ctx` / `before` (e.g. to resolve a vendor name); called at propose and edit time.
   */
  summarize?(input: TInput, payload: TPayload, ctx: TCtx, before: TRecord | null): string | Promise<string>;

  // ── Rollback (optional; see README "Undo / rollback") ──────────────────────────────────────

  /**
   * Can this executed op be undone? Pure (no I/O). Default when `compensate` exists: yes. Return a
   * reason when the system has no real undo for this op (e.g. a received purchase order).
   */
  canCompensate?(op: CompensableOp): CompensationCheck;
  /**
   * Plans the compensating change from the record's *current* state (it may have moved on since the
   * original write). Called when the undo is proposed (and when an approver edits it) and again to
   * verify after the undo ran. Throw `InputValidationError` when the record can no longer be undone.
   */
  planCompensation?(ctx: TCtx, op: CompensableOp, result: OpResult): Promise<CompensationPlan>;
  /**
   * Applies the undo (delete what was created, restore the `before` values). Runs in the harness
   * executor like any write, after the undo proposal was approved. Must be idempotent by value
   * (deleting an already-deleted record or restoring an already-restored value succeeds), because
   * a compensation has no record to stamp an idempotency key into.
   */
  compensate?(ctx: TCtx, op: CompensableOp, result: OpResult): Promise<WrittenRecord<unknown>>;
  /**
   * Why ops of an action without `compensate` cannot be undone, for the undo preview
   * ("An email cannot be unsent: send a correction instead").
   */
  readonly irreversible?: string;
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

/**
 * The policy value of a planned payload: the action's own `valueOf` hook (an inherited
 * `Object.prototype.valueOf` never counts), 0 for `moneyless` actions, else null (unknown).
 */
export function opValueOf<TCtx>(action: AnyAction<TCtx>, payload: unknown): number | null {
  if (Object.hasOwn(action, 'valueOf') && typeof action.valueOf === 'function') return action.valueOf(payload);
  return action.moneyless ? 0 : null;
}

/** Registry names of compensating actions: `<action>.undo` (derived, never in the catalog). */
export const UNDO_SUFFIX = '.undo';
export const undoActionName = (action: string): string => `${action}${UNDO_SUFFIX}`;
/** The original action of a compensating action name, or null for a regular action. */
export const undoBaseOf = (action: string): string | null => (action.endsWith(UNDO_SUFFIX) ? action.slice(0, -UNDO_SUFFIX.length) : null);
