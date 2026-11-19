/**
 * Compensating actions: how an undo becomes an ordinary governed write.
 *
 * For every action with a `compensate` hook the registry derives `<action>.undo` (see
 * `Registry.action`). An undo proposal is made of these derived ops, so it goes through exactly the
 * same pipeline as any change: plan (from the record's *current* state) → diff → policy → a human
 * decision → the idempotent executor → read-after-write verification → audit.
 *
 * - input: which op is undone (`undoOf`) and a snapshot of the executed op (op references already
 *   resolved, so the hooks see real ids and numbers).
 * - before: `planCompensation(...).current`, the record as it is now.
 * - payload: the snapshot plus the planned `target` (`null` = delete), its value and summary.
 * - diff: current → target (a delete shows the whole record as removed).
 * - execute: the action's `compensate` hook (idempotent by value).
 * - verify: re-plans and checks the record now equals the target (or is gone).
 */
import { z } from 'zod';
import { defineAction, undoActionName, type AnyAction, type CompensableOp, type CompensationPlan } from './action';
import { diff, FieldChangeSchema, type FieldChange } from './diff';
import { OpResultSchema } from './proposal';
import { matchesExpected, type VerifyResult } from './verify';

export const CompensatedOpSchema = z.object({
  index: z.number().int().nonnegative(),
  action: z.string(),
  resource: z.string(),
  input: z.unknown(),
  before: z.unknown(),
  payload: z.unknown(),
  diff: z.array(FieldChangeSchema),
  result: OpResultSchema,
});
export type CompensatedOp = z.infer<typeof CompensatedOpSchema>;

export const UndoRefSchema = z.object({ proposalId: z.string().min(1), opIndex: z.number().int().nonnegative() });
export type UndoRef = z.infer<typeof UndoRefSchema>;

/** Input of a derived `<action>.undo` op (built by `harness.undo`, never by an agent). */
export const CompensationInputSchema = z.object({ undoOf: UndoRefSchema, op: CompensatedOpSchema });
export type CompensationInput = z.infer<typeof CompensationInputSchema>;

export const CompensationPayloadSchema = CompensationInputSchema.extend({
  /** Sparse target state of the record after the undo; null = the record is deleted. */
  target: z.unknown(),
  value: z.number().nullable(),
  summary: z.string().nullable(),
});
export type CompensationPayload = z.infer<typeof CompensationPayloadSchema>;

const snapshot = (op: CompensatedOp): CompensableOp => ({
  index: op.index,
  action: op.action,
  resource: op.resource,
  input: op.input,
  before: op.before,
  payload: op.payload,
  diff: op.diff,
});

const isNil = (v: unknown) => v === null || v === undefined;

/** The derived compensating action for `base` (which must have `compensate`). */
export function compensationAction<TCtx>(base: AnyAction<TCtx>): AnyAction<TCtx> {
  const compensate = base.compensate;
  if (!compensate) throw new Error(`Action '${base.name}' has no compensate hook`);
  // loadBefore and plan receive the same parsed input object: plan once per propose/edit.
  const plans = new WeakMap<object, CompensationPlan>();
  const planFor = async (ctx: TCtx, input: CompensationInput): Promise<CompensationPlan> => {
    if (!base.planCompensation) return { current: null, target: null };
    return base.planCompensation(ctx, snapshot(input.op), input.op.result);
  };

  const derived = defineAction<TCtx, CompensationInput, CompensationPayload, unknown>({
    name: undoActionName(base.name),
    resource: base.resource,
    risk: base.risk,
    requiredScope: 'propose',
    description: `Undo an executed '${base.name}' op (compensating write). Created only by harness.undo.`,
    input: CompensationInputSchema,
    payload: CompensationPayloadSchema,

    loadBefore: async (ctx, input) => {
      const plan = await planFor(ctx, input);
      plans.set(input, plan);
      return plan.current ?? null;
    },

    plan: async (ctx, input): Promise<CompensationPayload> => {
      const plan = plans.get(input) ?? (await planFor(ctx, input));
      const value = plan.value !== undefined ? plan.value : base.moneyless ? 0 : null;
      return { ...input, target: plan.target ?? null, value, summary: plan.summary ?? null };
    },

    diff: (before, payload): FieldChange[] => {
      if (payload.target === null) return isNil(before) ? [] : [{ path: [], kind: 'removed', before, after: undefined }];
      return diff(before ?? null, payload.target);
    },

    execute: (ctx, payload) => compensate.call(base, ctx, snapshot(payload.op), payload.op.result),

    // A compensation sets a state (deleted / restored value), so repeating it is harmless: the
    // executor record is the only dedupe it needs (there is no record to stamp a key into).
    findByIdempotencyKey: async () => null,

    verify: async (ctx, _recordId, payload): Promise<VerifyResult> => {
      const now = await planFor(ctx, payload);
      if (payload.target === null) {
        return isNil(now.current) ? { ok: true, mismatches: [] } : { ok: false, mismatches: [{ path: [], expected: null, actual: now.current }] };
      }
      return matchesExpected(now.current, payload.target);
    },

    valueOf: (payload) => payload.value,
    ...(base.moneyless ? { moneyless: true } : {}),
    irreversible: 'An undo cannot itself be undone: propose the original change again instead.',

    summarize: (input, payload) => payload.summary ?? `Undo op #${input.op.index} (${input.op.action})`,
  });
  return derived as AnyAction<TCtx>;
}
