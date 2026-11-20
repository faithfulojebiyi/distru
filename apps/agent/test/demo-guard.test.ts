/**
 * DEMO_MODE account lock: a Better Auth instance (memory adapter) with the app's `before` hook. The
 * seeded demo accounts cannot change password / email / profile or reset their password; other
 * accounts can.
 */
import { describe, expect, test } from 'bun:test';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { APIError } from 'better-auth/api';
import { emailOTP } from 'better-auth/plugins';
import { DEMO_ACCOUNT_LOCKED_MESSAGE, demoAccountGuard } from '../src/auth/demo-guard';
import { isDemoEmail } from '../src/db/demo-users';

const DEMO = 'approver@demo.dev';
const OTHER = 'someone@example.com';
const PASSWORD = 'demo-password';

async function setup() {
  const auth = betterAuth({
    secret: 'test-secret-test-secret-test-secret-1234',
    baseURL: 'http://localhost:4111',
    basePath: '/api/auth',
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    emailAndPassword: { enabled: true, sendResetPassword: async () => undefined },
    user: { changeEmail: { enabled: true } },
    hooks: { before: demoAccountGuard(isDemoEmail) },
    plugins: [emailOTP({ sendVerificationOTP: async () => undefined })],
  });
  const signUp = async (email: string) => {
    const { headers } = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: email }, returnHeaders: true });
    const cookie = headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    return new Headers({ cookie });
  };
  return { auth, demo: await signUp(DEMO), other: await signUp(OTHER) };
}

async function statusOf(call: () => Promise<unknown>): Promise<number | 'ok'> {
  try {
    await call();
    return 'ok';
  } catch (err) {
    if (err instanceof APIError) {
      if (err.statusCode === 403) expect(err.message).toBe(DEMO_ACCOUNT_LOCKED_MESSAGE);
      return err.statusCode;
    }
    throw err;
  }
}

describe('DEMO_MODE: seeded demo accounts are locked', () => {
  test('isDemoEmail: the seeded addresses only (case-insensitive)', () => {
    expect(isDemoEmail('operator@demo.dev')).toBe(true);
    expect(isDemoEmail(' Approver@Demo.dev ')).toBe(true);
    expect(isDemoEmail('someone@demo.dev')).toBe(false);
    expect(isDemoEmail(undefined)).toBe(false);
  });

  test('change password / email / profile and delete are 403 for a demo account', async () => {
    const { auth, demo } = await setup();
    expect(await statusOf(() => auth.api.changePassword({ headers: demo, body: { currentPassword: PASSWORD, newPassword: 'taken-over-123' } }))).toBe(403);
    expect(await statusOf(() => auth.api.changeEmail({ headers: demo, body: { newEmail: 'mine@example.com' } }))).toBe(403);
    expect(await statusOf(() => auth.api.updateUser({ headers: demo, body: { name: 'Hijacked' } }))).toBe(403);
    expect(await statusOf(() => auth.api.deleteUser({ headers: demo, body: { password: PASSWORD } }))).toBe(403);
    expect(await statusOf(() => auth.api.revokeOtherSessions({ headers: demo }))).toBe(403);
    // The account still signs in with the shared password.
    expect(await statusOf(() => auth.api.signInEmail({ body: { email: DEMO, password: PASSWORD } }))).toBe('ok');
  });

  test('password reset (link or emailed code) is 403 for a demo account', async () => {
    const { auth } = await setup();
    expect(await statusOf(() => auth.api.requestPasswordReset({ body: { email: DEMO } }))).toBe(403);
    expect(await statusOf(() => auth.api.sendVerificationOTP({ body: { email: DEMO, type: 'forget-password' } }))).toBe(403);
    expect(await statusOf(() => auth.api.resetPasswordEmailOTP({ body: { email: DEMO, otp: '123456', password: 'taken-over-123' } }))).toBe(403);
    // A sign-in code is not a takeover.
    expect(await statusOf(() => auth.api.sendVerificationOTP({ body: { email: DEMO, type: 'sign-in' } }))).toBe('ok');
  });

  test('other accounts are unaffected', async () => {
    const { auth, other } = await setup();
    expect(await statusOf(() => auth.api.updateUser({ headers: other, body: { name: 'New name' } }))).toBe('ok');
    expect(await statusOf(() => auth.api.changePassword({ headers: other, body: { currentPassword: PASSWORD, newPassword: 'another-pass-123' } }))).toBe('ok');
    expect(await statusOf(() => auth.api.requestPasswordReset({ body: { email: OTHER } }))).toBe('ok');
  });
});
