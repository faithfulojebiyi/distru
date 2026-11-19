import { z } from 'zod';
import { deepEqual, isPlainObject, type PlainObject } from './json';

export const PathSegmentSchema = z.union([z.string(), z.number()]);
export type PathSegment = z.infer<typeof PathSegmentSchema>;

export const ChangeKindSchema = z.enum(['added', 'removed', 'changed']);
export type ChangeKind = z.infer<typeof ChangeKindSchema>;

export const FieldChangeSchema = z.object({
  path: z.array(PathSegmentSchema),
  kind: ChangeKindSchema,
  before: z.unknown(),
  after: z.unknown(),
});
export type FieldChange = z.infer<typeof FieldChangeSchema>;

export interface DiffOptions {
  /**
   * Sparse-upsert semantics (default `true`): a key missing from `after` means "unchanged",
   * not "removed". This matches Distru's upsert endpoints, where you send only what changes.
   */
  sparse?: boolean;
  /** Key used to match elements of arrays of objects (Distru line `items`). Default `id`. */
  keyBy?: string;
}

/** Path segment addressing an element of a keyed array, e.g. `id=42`. */
export const keySegment = (keyBy: string, key: string): string => `${keyBy}=${key}`;
/** Path segment for a new (key-less) element at `index` of the payload array, e.g. `new:0`. */
export const newSegment = (index: number): string => `new:${index}`;

/**
 * Field-level structural diff of `before` (current record, or null when creating) against
 * `after` (the payload that will be sent).
 *
 * Arrays whose elements are all objects are diffed as keyed collections: elements with a key are
 * matched against `before`, key-less elements are additions, and keys present in `before` but
 * absent from `after` are removals (Distru replaces the full `items` list when it is sent). Other
 * arrays are compared as whole values.
 */
export function diff(before: unknown, after: unknown, options: DiffOptions = {}): FieldChange[] {
  const opts: Required<DiffOptions> = { sparse: options.sparse ?? true, keyBy: options.keyBy ?? 'id' };
  const root = (before === null || before === undefined) && isPlainObject(after) ? {} : before;
  const out: FieldChange[] = [];
  walk(root, after, [], opts, out);
  return out;
}

function walk(b: unknown, a: unknown, path: PathSegment[], opts: Required<DiffOptions>, out: FieldChange[]): void {
  if (a === undefined && opts.sparse) return;
  if (deepEqual(b, a)) return;
  if (b === undefined) {
    out.push({ path, kind: 'added', before: undefined, after: a });
    return;
  }
  if (a === undefined) {
    out.push({ path, kind: 'removed', before: b, after: undefined });
    return;
  }
  if (isPlainObject(b) && isPlainObject(a)) {
    const keys = opts.sparse ? Object.keys(a) : [...new Set([...Object.keys(b), ...Object.keys(a)])];
    for (const key of keys) walk(b[key], a[key], [...path, key], opts, out);
    return;
  }
  if (Array.isArray(b) && Array.isArray(a) && isKeyedArray(b, a, opts.keyBy)) {
    walkKeyed(b, a, path, opts, out);
    return;
  }
  out.push({ path, kind: 'changed', before: b, after: a });
}

function walkKeyed(
  b: PlainObject[],
  a: PlainObject[],
  path: PathSegment[],
  opts: Required<DiffOptions>,
  out: FieldChange[],
): void {
  const beforeByKey = new Map<string, PlainObject>();
  for (const el of b) {
    const key = keyOf(el, opts.keyBy);
    if (key !== undefined) beforeByKey.set(key, el);
  }
  const seen = new Set<string>();
  a.forEach((el, index) => {
    const key = keyOf(el, opts.keyBy);
    if (key === undefined) {
      out.push({ path: [...path, newSegment(index)], kind: 'added', before: undefined, after: el });
      return;
    }
    seen.add(key);
    const segment = keySegment(opts.keyBy, key);
    const prev = beforeByKey.get(key);
    if (prev === undefined) out.push({ path: [...path, segment], kind: 'added', before: undefined, after: el });
    else walk(prev, el, [...path, segment], opts, out);
  });
  for (const [key, prev] of beforeByKey) {
    if (!seen.has(key)) {
      out.push({ path: [...path, keySegment(opts.keyBy, key)], kind: 'removed', before: prev, after: undefined });
    }
  }
}

/** Keyed when every element is an object, every `before` element has a key, and there is something to match. */
function isKeyedArray(b: unknown[], a: unknown[], keyBy: string): boolean {
  if (b.length + a.length === 0) return false;
  return (
    a.every(isPlainObject) && b.every((el) => isPlainObject(el) && keyOf(el, keyBy) !== undefined)
  );
}

export function keyOf(el: PlainObject, keyBy: string): string | undefined {
  const key = el[keyBy];
  return typeof key === 'string' || typeof key === 'number' ? String(key) : undefined;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** `['items', 'id=42', 'quantity']` → `items[id=42].quantity` */
export function formatPath(path: readonly PathSegment[]): string {
  if (path.length === 0) return '(root)';
  return path
    .map((seg, i) => {
      if (typeof seg === 'number') return `[${seg}]`;
      if (IDENTIFIER.test(seg)) return i === 0 ? seg : `.${seg}`;
      return `[${seg}]`;
    })
    .join('');
}

function formatValue(value: unknown, max = 60): string {
  const text = value === undefined ? 'undefined' : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One line per change, e.g. `~ items[id=42].quantity: 5 → 12`. */
export function summarizeDiff(changes: readonly FieldChange[], options: { maxLines?: number } = {}): string {
  if (changes.length === 0) return 'No changes';
  const max = options.maxLines ?? 50;
  const lines = changes.slice(0, max).map((c) => {
    const path = formatPath(c.path);
    switch (c.kind) {
      case 'added':
        return `+ ${path}: ${formatValue(c.after)}`;
      case 'removed':
        return `- ${path}: ${formatValue(c.before)}`;
      case 'changed':
        return `~ ${path}: ${formatValue(c.before)} → ${formatValue(c.after)}`;
    }
  });
  if (changes.length > max) lines.push(`… and ${changes.length - max} more`);
  return lines.join('\n');
}
