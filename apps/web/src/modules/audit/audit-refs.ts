// Ops Agent addition to the audit module (no carbonme counterpart: carbonme audit rows have no cross-row references).
// Mirrors the harness's packages/harness/src/refs.ts placeholder grammar so the drawer can show
// `{{op:10.purchase_number}} → PO-524` next to the value the approver saw.
import type { AuditEvent, ProposalOp } from '../../api/generated/opsAgentAPI.schemas';

export type RefValue = string | number | boolean | null;

const REF = /\{\{op:(\d+)\.([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

export type OpRefMatch = { token: string; index: number; field: string };

/** Every `{{op:N.field}}` placeholder in a string, in order. */
export const findRefs = (text: string): OpRefMatch[] =>
  [...text.matchAll(REF)].map((match) => ({
    token: match[0],
    index: Number(match[1]),
    field: match[2] ?? '',
  }));

export const hasRefs = (value: unknown): value is string =>
  typeof value === 'string' && findRefs(value).length > 0;

/** A string cut into plain text and placeholder parts, for rendering the placeholders as chips. */
export const splitRefs = (text: string): (string | OpRefMatch)[] => {
  const parts: (string | OpRefMatch)[] = [];
  let last = 0;
  for (const match of text.matchAll(REF)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    parts.push({ token: match[0], index: Number(match[1]), field: match[2] ?? '' });
    last = at + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
};

const isRefValue = (value: unknown): value is RefValue =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);

const asResolved = (value: unknown): Record<string, RefValue> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, RefValue] => isRefValue(entry[1])),
  );
};

/**
 * What each placeholder resolved to: the executor's record on the event (`data.resolved`) or the op
 * result (`result.resolved`); for an op not written yet, what the referenced op already exported
 * (`result.outputs` / `recordId`), marked as not yet applied.
 */
export type Resolution = { value: RefValue; applied: boolean } | null;

export const resolveRef = (
  ref: OpRefMatch,
  event: AuditEvent,
  op: ProposalOp | undefined,
  ops: readonly ProposalOp[],
): Resolution => {
  const recorded = { ...asResolved(op?.result?.resolved), ...asResolved(event.data.resolved) };
  if (Object.hasOwn(recorded, ref.token)) return { value: recorded[ref.token] ?? null, applied: true };
  const source = ops.find((item) => item.index === ref.index);
  if (!source?.result || source.status !== 'executed') return null;
  if (ref.field === 'recordId') return source.result.recordId === null ? null : { value: source.result.recordId, applied: false };
  const outputs = asResolved(source.result.outputs);
  return Object.hasOwn(outputs, ref.field) ? { value: outputs[ref.field] ?? null, applied: false } : null;
};

/** The text with every placeholder replaced by its resolved value (placeholders left as-is when unknown). */
export const resolveText = (
  text: string,
  resolve: (ref: OpRefMatch) => Resolution,
): string =>
  text.replace(REF, (token, index: string, field: string) => {
    const resolution = resolve({ token, index: Number(index), field });
    return resolution ? String(resolution.value) : token;
  });

/** Every placeholder an op's diff and payload use, deduplicated, with what it resolved to. */
export const opRefs = (
  event: AuditEvent,
  op: ProposalOp | undefined,
  ops: readonly ProposalOp[],
): { ref: OpRefMatch; resolution: Resolution }[] => {
  const seen = new Map<string, OpRefMatch>();
  const visit = (value: unknown) => {
    if (typeof value === 'string') for (const ref of findRefs(value)) seen.set(ref.token, ref);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(op?.payload);
  visit(op?.diff.map((change) => change.after));
  visit(event.data.resolved && typeof event.data.resolved === 'object' ? Object.keys(event.data.resolved).join(' ') : null);
  return [...seen.values()].map((ref) => ({ ref, resolution: resolveRef(ref, event, op, ops) }));
};
