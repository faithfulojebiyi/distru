import { describe, expect, test } from 'bun:test';
import { diff, formatPath, matchesExpected, summarizeDiff } from '../src';

describe('diff', () => {
  test('identical values produce no changes', () => {
    expect(diff({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 2] } })).toEqual([]);
  });

  test('create (before = null) lists every top-level field as added', () => {
    expect(diff(null, { vendorId: 'v1', status: 'draft' })).toEqual([
      { path: ['vendorId'], kind: 'added', before: undefined, after: 'v1' },
      { path: ['status'], kind: 'added', before: undefined, after: 'draft' },
    ]);
  });

  test('nested objects are diffed field by field', () => {
    const changes = diff(
      { vendor: { id: 'v1', address: { city: 'Oakland', zip: '94607' } } },
      { vendor: { id: 'v1', address: { city: 'Berkeley', zip: '94607' } } },
    );
    expect(changes).toEqual([{ path: ['vendor', 'address', 'city'], kind: 'changed', before: 'Oakland', after: 'Berkeley' }]);
  });

  test('sparse (default): keys missing from the payload are unchanged, not removed', () => {
    expect(diff({ status: 'draft', notes: 'keep me' }, { status: 'open' })).toEqual([
      { path: ['status'], kind: 'changed', before: 'draft', after: 'open' },
    ]);
  });

  test('non-sparse: keys missing from after are removals', () => {
    expect(diff({ status: 'draft', notes: 'x' }, { status: 'draft' }, { sparse: false })).toEqual([
      { path: ['notes'], kind: 'removed', before: 'x', after: undefined },
    ]);
  });

  test('explicit null in the payload is a change', () => {
    expect(diff({ dueDate: '2026-01-01' }, { dueDate: null })).toEqual([
      { path: ['dueDate'], kind: 'changed', before: '2026-01-01', after: null },
    ]);
  });

  describe('line items keyed by id', () => {
    const before = {
      items: [
        { id: 1, productId: 'a', quantity: 5 },
        { id: 2, productId: 'b', quantity: 1 },
        { id: 3, productId: 'c', quantity: 9 },
      ],
    };

    test('matched by id (order-independent), sparse inside items, new items added, omitted ids removed', () => {
      const changes = diff(before, {
        items: [
          { id: 2, quantity: 1 }, // unchanged (sparse)
          { id: 1, quantity: 12 }, // changed
          { productId: 'd', quantity: 4 }, // new
        ],
      });
      expect(changes).toEqual([
        { path: ['items', 'id=1', 'quantity'], kind: 'changed', before: 5, after: 12 },
        { path: ['items', 'new:2'], kind: 'added', before: undefined, after: { productId: 'd', quantity: 4 } },
        { path: ['items', 'id=3'], kind: 'removed', before: { id: 3, productId: 'c', quantity: 9 }, after: undefined },
      ]);
    });

    test('items omitted entirely from a sparse payload are untouched', () => {
      expect(diff(before, { status: 'open' })).toEqual([{ path: ['status'], kind: 'added', before: undefined, after: 'open' }]);
    });

    test('string and number ids match each other', () => {
      expect(diff({ items: [{ id: 7, q: 1 }] }, { items: [{ id: '7', q: 1 }] })).toEqual([
        { path: ['items', 'id=7', 'id'], kind: 'changed', before: 7, after: '7' },
      ]);
    });

    test('custom keyBy', () => {
      expect(diff({ lines: [{ sku: 'a', q: 1 }] }, { lines: [{ sku: 'a', q: 2 }] }, { keyBy: 'sku' })).toEqual([
        { path: ['lines', 'sku=a', 'q'], kind: 'changed', before: 1, after: 2 },
      ]);
    });
  });

  test('arrays of primitives are compared as whole values', () => {
    expect(diff({ tags: ['a', 'b'] }, { tags: ['a', 'c'] })).toEqual([
      { path: ['tags'], kind: 'changed', before: ['a', 'b'], after: ['a', 'c'] },
    ]);
  });

  test('type changes are reported as changed', () => {
    expect(diff({ a: { b: 1 } }, { a: 'flat' })).toEqual([{ path: ['a'], kind: 'changed', before: { b: 1 }, after: 'flat' }]);
  });
});

describe('formatPath / summarizeDiff', () => {
  test('formats keyed segments in brackets', () => {
    expect(formatPath(['items', 'id=1', 'quantity'])).toBe('items[id=1].quantity');
    expect(formatPath(['tags', 0])).toBe('tags[0]');
    expect(formatPath([])).toBe('(root)');
  });

  test('human summary', () => {
    const summary = summarizeDiff(
      diff({ status: 'draft', items: [{ id: 1, quantity: 5 }] }, { status: 'open', items: [{ id: 1, quantity: 8 }, { quantity: 2 }] }),
    );
    expect(summary).toBe(
      ['~ status: "draft" → "open"', '~ items[id=1].quantity: 5 → 8', '+ items[new:1]: {"quantity":2}'].join('\n'),
    );
    expect(summarizeDiff([])).toBe('No changes');
  });

  test('truncates long summaries', () => {
    const changes = diff(null, Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}`, i])));
    expect(summarizeDiff(changes, { maxLines: 2 }).split('\n')).toEqual(['+ f0: 0', '+ f1: 1', '… and 3 more']);
  });
});

describe('matchesExpected (read-after-write)', () => {
  test('sparse subset match passes; loose numbers', () => {
    expect(matchesExpected({ id: 'po-1', total: '50.00', status: 'open' }, { total: 50, status: 'open' }).ok).toBe(true);
  });

  test('new key-less items match an unclaimed actual item that gained an id', () => {
    const actual = { items: [{ id: 'li-1', productId: 'a', quantity: 2 }, { id: 'li-9', productId: 'b', quantity: 4 }] };
    const expected = { items: [{ id: 'li-1', quantity: 2 }, { productId: 'b', quantity: 4 }] };
    expect(matchesExpected(actual, expected)).toEqual({ ok: true, mismatches: [] });
  });

  test('reports changed fields, missing items and unexpected items', () => {
    const actual = { status: 'draft', items: [{ id: 'li-1', quantity: 3 }, { id: 'li-2', quantity: 1 }] };
    const expected = { status: 'open', items: [{ id: 'li-1', quantity: 2 }, { quantity: 7 }] };
    const result = matchesExpected(actual, expected);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([
      { path: ['status'], expected: 'open', actual: 'draft' },
      { path: ['items', 'id=li-1', 'quantity'], expected: 2, actual: 3 },
      { path: ['items', 'new:1'], expected: { quantity: 7 }, actual: undefined },
      { path: ['items', 'id=li-2'], expected: undefined, actual: { id: 'li-2', quantity: 1 } },
    ]);
  });

  test('missing record fails', () => {
    expect(matchesExpected(null, { status: 'open' }).ok).toBe(false);
  });
});
