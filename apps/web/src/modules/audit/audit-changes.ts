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

// ── Drawer additions: every field of an op, changed or not, and values as a person reads them ───

export type DrawerChange = AuditChange & { kind: 'added' | 'removed' | 'changed' | 'unchanged' };

/** The op's diff (added / removed / changed), then the fields the op carried over untouched. */
export const opFieldRows = (op: ProposalOp): DrawerChange[] => {
  const changed: DrawerChange[] = op.diff.map((change) => ({
    field: formatPath(change.path),
    before: change.before,
    after: change.after,
    kind: change.kind,
  }));
  const before = flatten(op.before);
  const after = flatten(op.payload);
  const unchanged: DrawerChange[] = [...after.keys()]
    .filter((field) => before.has(field) && JSON.stringify(before.get(field)) === JSON.stringify(after.get(field)))
    .map((field) => ({ field, before: before.get(field), after: after.get(field), kind: 'unchanged' }));
  return [...changed, ...unchanged];
};

/** A failed read-after-write check as rows: expected → actual, all of them changed. */
export const mismatchRows = (event: AuditEvent): DrawerChange[] =>
  mismatchChanges(event).map((change) => ({ ...change, kind: 'changed' }));

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const CODE = /^[\w.:/#@-]+$/;

export type FormattedValue = {
  /** What a person reads. */
  text: string;
  /** The value as stored, when it differs (shown quieter underneath). */
  raw: string | null;
  /** Ids, codes, keys and JSON read better in monospace. */
  mono: boolean;
  /** Nothing on this side. */
  empty: boolean;
};

const MONEY_HINT = /(price|cost|total|amount|value|subtotal)$/i;

/** One value for the drawer: dates and money formatted, ids and codes monospace, objects as indented JSON. */
export const formatAuditValue = (field: string, value: unknown): FormattedValue => {
  if (value === undefined) return { text: 'not set', raw: null, mono: false, empty: true };
  if (value === null) return { text: 'null', raw: null, mono: true, empty: true };
  const leaf = field.split(/[.\]]/).filter(Boolean).at(-1) ?? field;
  if (typeof value === 'number') {
    if (MONEY_HINT.test(leaf))
      return {
        text: value.toLocaleString(undefined, { style: 'currency', currency: 'USD' }),
        raw: null,
        mono: false,
        empty: false,
      };
    return { text: value.toLocaleString(undefined, { maximumFractionDigits: 6 }), raw: null, mono: false, empty: false };
  }
  if (typeof value === 'boolean') return { text: value ? 'true' : 'false', raw: null, mono: true, empty: false };
  if (typeof value === 'string') {
    if (ISO_DATE.test(value)) {
      const [y, m, d] = value.split('-').map(Number);
      const date = new Date(y ?? 0, (m ?? 1) - 1, d ?? 1);
      return {
        text: date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
        raw: value,
        mono: false,
        empty: false,
      };
    }
    if (ISO_DATETIME.test(value) && !Number.isNaN(Date.parse(value)))
      return {
        text: new Date(value).toLocaleString(undefined, {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        }),
        raw: value,
        mono: false,
        empty: false,
      };
    if (value === '') return { text: '(empty)', raw: null, mono: false, empty: true };
    return { text: value, raw: null, mono: CODE.test(value) && /\d|[_.:-]/.test(value), empty: false };
  }
  return { text: JSON.stringify(value, null, 2), raw: null, mono: true, empty: false };
};
