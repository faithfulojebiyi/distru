import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { requireRole, requireUser, sessionMiddleware, type AuthVariables, type SessionUser } from '../src/auth/session';

const users: Record<string, SessionUser> = {
  operator: { id: 'u-op', email: 'operator@demo.dev', name: 'Op', role: 'operator' },
  approver: { id: 'u-ap', email: 'approver@demo.dev', name: 'Ap', role: 'approver' },
};

/** Fake resolver: `Authorization: Bearer <operator|approver>` selects the user. */
const resolve = async (headers: Headers) => users[headers.get('authorization')?.replace('Bearer ', '') ?? ''] ?? null;

function app() {
  const a = new Hono<{ Variables: AuthVariables }>();
  a.use('*', sessionMiddleware(resolve));
  a.get('/any', requireUser, (c) => c.json({ id: c.get('user')!.id }));
  a.get('/approver', requireRole('approver'), (c) => c.json({ ok: true }));
  a.get('/either', requireRole('operator', 'approver'), (c) => c.json({ ok: true }));
  return a;
}

const get = (path: string, as?: string) =>
  app().request(path, { headers: as ? { authorization: `Bearer ${as}` } : {} });

describe('requireUser', () => {
  test('401 without a session', async () => {
    expect((await get('/any')).status).toBe(401);
  });
  test('passes with any session', async () => {
    const res = await get('/any', 'operator');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'u-op' });
  });
});

describe("requireRole('approver')", () => {
  test('401 without a session', async () => {
    const res = await get('/approver');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'unauthorized' });
  });
  test('403 for an operator', async () => {
    const res = await get('/approver', 'operator');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'forbidden' });
  });
  test('passes for an approver', async () => {
    expect((await get('/approver', 'approver')).status).toBe(200);
  });
  test('accepts any of several roles', async () => {
    expect((await get('/either', 'operator')).status).toBe(200);
    expect((await get('/either', 'approver')).status).toBe(200);
  });
});

describe('sessionMiddleware', () => {
  test('treats a throwing resolver as anonymous', async () => {
    const a = new Hono<{ Variables: AuthVariables }>();
    a.use(
      '*',
      sessionMiddleware(async () => {
        throw new Error('db down');
      }),
    );
    a.get('/x', requireUser, (c) => c.text('nope'));
    expect((await a.request('/x')).status).toBe(401);
  });
});
