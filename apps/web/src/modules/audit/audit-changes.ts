// Adapted from carbonme apps/admin/src/modules/customers/audit-changes.ts.
import type { AuditEvent, FieldChange, ProposalOp } from '../../api/generated/opsAgentAPI.schemas';
import { formatPath } from '../proposals/proposal-values';

export type AuditChange = { field: string; before: unknown; after: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Nested objects as dotted paths, so `{effects: {granted: 0}}` reads as `effects.granted`; arrays stay whole. */
const flatten = (
  value: unknown,
  prefix = '',
  into = new Map<string, unknown>(),
): Map<string, unknown> => {
  if (!isRecord(value)) {
    if (prefix) into.set(prefix, value);

    return into;
  }

  for (const [key, child] of Object.entries(value))
    flatten(child, prefix ? `${prefix}.${key}` : key, into);

  return into;
};

/** Every field that differs between before and after, in the order it first appears; unchanged fields are left out. */
export const auditChanges = (
  before: unknown,
  after: unknown,
): AuditChange[] => {
  const old = flatten(before);

  const next = flatten(after);

  const fields = [...new Set([...old.keys(), ...next.keys()])];

  return fields
    .map((field) => ({ field, before: old.get(field), after: next.get(field) }))
    .filter(
      (change) =>
        JSON.stringify(change.before) !== JSON.stringify(change.after),
    );
};

/** One value as staff read it: text unquoted, nothing as a dash, anything else as JSON. */
export const auditValue = (value: unknown): string => {
  if (value === undefined || value === null) return '–';

  return typeof value === 'string' ? value : JSON.stringify(value);
};

/** The JSON indented for reading, or a dash when the side is empty. */
export const auditJson = (value: unknown): string =>
  value === undefined || value === null ? '–' : JSON.stringify(value, null, 2);

/** "status: issued → paid · 4 more" for the table; the drawer has the rest. */
export const auditSummary = (changes: AuditChange[]): string => {
  const [first] = changes;

  if (!first) return '–';

  const more = changes.length > 1 ? ` · ${changes.length - 1} more` : '';

  return `${first.field}: ${auditValue(first.before)} → ${auditValue(first.after)}${more}`;
};

// ── Ops Agent additions: the changes an audit event stands for ──────────────────────────────────


/** An op's field-level diff as audit changes: `items[new:0].quantity: – → 120`. */
export const opChanges = (diff: readonly FieldChange[]): AuditChange[] =>
  diff.map((change) => ({ field: formatPath(change.path), before: change.before, after: change.after }));

const asRecord = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? value : null;

/** A failed read-after-write check as changes: what the harness expected → what Distru held. */
export const mismatchChanges = (event: AuditEvent): AuditChange[] => {
  const mismatches = Array.isArray(event.data.mismatches) ? event.data.mismatches : [];
  return mismatches.flatMap((raw) => {
    const mismatch = asRecord(raw);
    if (!mismatch || !Array.isArray(mismatch.path)) return [];
    return [{ field: formatPath(mismatch.path as (string | number)[]), before: mismatch.expected, after: mismatch.actual }];
  });
};

/** Which changes an event shows when its row opens: the op's diff, the mismatch, or none. */
export const eventChanges = (event: AuditEvent, op: ProposalOp | undefined): AuditChange[] => {
  if (event.type === 'op.verify_failed') return mismatchChanges(event);
  if (op && event.type.startsWith('op.')) return opChanges(op.diff);
  return [];
};
