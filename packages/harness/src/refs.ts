/**
 * Op references: a later op in a proposal can use a value that only exists after an earlier op ran
 * (the PO number of the purchase order created by op #0, its record id, …).
 *
 * A reference is a placeholder inside any string of an op's payload:
 *
 *   {{op:<index>.recordId}}         the record id op <index> wrote (or found by idempotency key)
 *   {{op:<index>.<output>}}         an output the action exported for that record (`outputs` hook),
 *                                   e.g. {{op:0.purchase_number}}
 *
 * Rules:
 * - At propose/edit time a reference may only point at an *earlier* op (the executor runs ops in
 *   order and stops at the first failure, so the referenced op has always succeeded first).
 * - The stored payload and the diff keep the placeholder: the approver sees exactly what will be
 *   resolved, never a guessed value.
 * - At execute time the executor substitutes the values from the referenced ops' results, runs and
 *   verifies the op with the resolved payload, and records every substitution in the op result
 *   (`result.resolved`). An unresolvable reference fails the op (not retried).
 */
import { HarnessError, InputValidationError } from './errors';
import { isPlainObject } from './json';

export type OutputValue = string | number | boolean | null;

const REF = /\{\{op:(\d+)\.([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

export interface OpRef {
  /** The placeholder exactly as written, e.g. `{{op:0.purchase_number}}`. */
  token: string;
  index: number;
  field: string;
}

/** Placeholder for a value of an earlier op (see module docs). */
export const opRef = (index: number, field: string): string => `{{op:${index}.${field}}}`;

function walkStrings(value: unknown, visit: (s: string) => void): void {
  if (typeof value === 'string') visit(value);
  else if (Array.isArray(value)) for (const v of value) walkStrings(v, visit);
  else if (isPlainObject(value)) for (const v of Object.values(value)) walkStrings(v, visit);
}

/** Every op reference in a value (deep), in order of appearance, deduplicated by token. */
export function findOpRefs(value: unknown): OpRef[] {
  const seen = new Map<string, OpRef>();
  walkStrings(value, (s) => {
    for (const m of s.matchAll(REF)) {
      if (!seen.has(m[0])) seen.set(m[0], { token: m[0], index: Number(m[1]), field: m[2]! });
    }
  });
  return [...seen.values()];
}

/** Propose/edit-time check: references in op `ownIndex` may only point at earlier ops. */
export function assertBackwardRefs(value: unknown, ownIndex: number): void {
  for (const ref of findOpRefs(value)) {
    if (ref.index >= ownIndex) {
      throw new InputValidationError(`Op #${ownIndex} references ${ref.token}: an op may only reference an earlier op (index < ${ownIndex})`);
    }
  }
}

/** An op reference that cannot be resolved at execute time (referenced op not executed, or no such value). */
export class UnresolvedReferenceError extends HarnessError {
  override readonly name = 'UnresolvedReferenceError';
  readonly code = 'unresolved_reference';
}

/** What the executor knows about an earlier op when resolving references. */
export interface RefSource {
  index: number;
  status: string;
  result: { recordId: string | null; outputs?: Record<string, OutputValue> | undefined } | null;
}

function valueOf(ref: OpRef, ops: readonly RefSource[]): OutputValue {
  const op = ops.find((o) => o.index === ref.index);
  if (!op || op.status !== 'executed' || !op.result) {
    throw new UnresolvedReferenceError(`${ref.token}: op #${ref.index} has not been executed`);
  }
  if (ref.field === 'recordId') {
    if (op.result.recordId === null) throw new UnresolvedReferenceError(`${ref.token}: op #${ref.index} has no record id`);
    return op.result.recordId;
  }
  const outputs = op.result.outputs ?? {};
  if (!Object.hasOwn(outputs, ref.field)) {
    throw new UnresolvedReferenceError(`${ref.token}: op #${ref.index} exported no '${ref.field}' (has: ${Object.keys(outputs).join(', ') || 'none'})`);
  }
  return outputs[ref.field] ?? null;
}

function substitute<T>(value: T, values: ReadonlyMap<string, OutputValue>): T {
  if (typeof value === 'string') {
    // A string that is exactly one placeholder takes the value's own type (e.g. a number).
    const whole = values.get(value);
    if (whole !== undefined) return whole as T;
    return value.replace(REF, (token) => (values.has(token) ? String(values.get(token)) : token)) as T;
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, values)) as T;
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, values)])) as T;
  return value;
}

/**
 * Resolve every op reference in `value` from the earlier ops' results. Returns the resolved value
 * and the substitutions made (`{ "{{op:0.purchase_number}}": "PO-1042" }`; empty when none).
 */
export function resolveOpRefs<T>(value: T, ops: readonly RefSource[]): { value: T; resolved: Record<string, OutputValue> } {
  const refs = findOpRefs(value);
  if (!refs.length) return { value, resolved: {} };
  const values = new Map(refs.map((r) => [r.token, valueOf(r, ops)]));
  return { value: substitute(value, values), resolved: Object.fromEntries(values) };
}
