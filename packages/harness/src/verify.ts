import { z } from 'zod';
import { keyOf, keySegment, newSegment, PathSegmentSchema, type PathSegment } from './diff';
import { deepEqual, isPlainObject, type PlainObject } from './json';

export const MismatchSchema = z.object({
  path: z.array(PathSegmentSchema),
  expected: z.unknown(),
  actual: z.unknown(),
});
export type Mismatch = z.infer<typeof MismatchSchema>;

export const VerifyResultSchema = z.object({ ok: z.boolean(), mismatches: z.array(MismatchSchema) });
export type VerifyResult = z.infer<typeof VerifyResultSchema>;

export interface MatchOptions {
  keyBy?: string;
  /** Treat `10` and `"10.00"` as equal (ERPs often return decimals as strings). Default true. */
  looseNumbers?: boolean;
}

/**
 * Read-after-write check: does `actual` (the record read back) contain everything in `expected`
 * (the payload that was sent)? Sparse: fields absent from `expected` are ignored. Keyed arrays:
 * keyed elements must match by key, key-less (new) elements must match some otherwise-unclaimed
 * actual element, and actual elements whose key was omitted from `expected` are unexpected.
 */
export function matchesExpected(actual: unknown, expected: unknown, options: MatchOptions = {}): VerifyResult {
  const opts: Required<MatchOptions> = { keyBy: options.keyBy ?? 'id', looseNumbers: options.looseNumbers ?? true };
  const mismatches: Mismatch[] = [];
  check(actual, expected, [], opts, mismatches);
  return { ok: mismatches.length === 0, mismatches };
}

function check(actual: unknown, expected: unknown, path: PathSegment[], opts: Required<MatchOptions>, out: Mismatch[]): void {
  if (expected === undefined) return;
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) {
      out.push({ path, expected, actual });
      return;
    }
    for (const key of Object.keys(expected)) check(actual[key], expected[key], [...path, key], opts, out);
    return;
  }
  if (Array.isArray(expected) && expected.length > 0 && expected.every(isPlainObject)) {
    if (!Array.isArray(actual) || !actual.every(isPlainObject)) {
      out.push({ path, expected, actual });
      return;
    }
    checkKeyed(actual, expected, path, opts, out);
    return;
  }
  if (!scalarEqual(actual, expected, opts.looseNumbers)) out.push({ path, expected, actual });
}

function checkKeyed(actual: PlainObject[], expected: PlainObject[], path: PathSegment[], opts: Required<MatchOptions>, out: Mismatch[]): void {
  const claimed = new Set<PlainObject>();
  const expectedKeys = new Set<string>();
  const pending: Array<{ el: PlainObject; index: number }> = [];

  expected.forEach((el, index) => {
    const key = keyOf(el, opts.keyBy);
    if (key === undefined) {
      pending.push({ el, index });
      return;
    }
    expectedKeys.add(key);
    const match = actual.find((a) => keyOf(a, opts.keyBy) === key);
    const segPath = [...path, keySegment(opts.keyBy, key)];
    if (!match) {
      out.push({ path: segPath, expected: el, actual: undefined });
      return;
    }
    claimed.add(match);
    check(match, el, segPath, opts, out);
  });

  for (const { el, index } of pending) {
    const match = actual.find((a) => {
      if (claimed.has(a)) return false;
      const key = keyOf(a, opts.keyBy);
      if (key !== undefined && expectedKeys.has(key)) return false;
      return matchesExpected(a, el, opts).ok;
    });
    if (match) claimed.add(match);
    else out.push({ path: [...path, newSegment(index)], expected: el, actual: undefined });
  }

  for (const a of actual) {
    if (claimed.has(a)) continue;
    const key = keyOf(a, opts.keyBy);
    out.push({ path: [...path, key === undefined ? '?' : keySegment(opts.keyBy, key)], expected: undefined, actual: a });
  }
}

function scalarEqual(actual: unknown, expected: unknown, loose: boolean): boolean {
  if (deepEqual(actual, expected)) return true;
  if (!loose) return false;
  const numeric = (v: unknown): number | undefined =>
    typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;
  const a = numeric(actual);
  const e = numeric(expected);
  return a !== undefined && e !== undefined && a === e;
}
