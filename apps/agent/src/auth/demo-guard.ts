import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';

/**
 * DEMO_MODE: the seeded demo accounts are shared by every visitor, so nobody may take one over or lock
 * the others out. Better Auth `hooks.before` refuses, with 403, every endpoint that changes a demo
 * account's password, email or profile, deletes it, or signs its other sessions out.
 */

/** Endpoints acting on the signed-in user (the session's email decides). */
export const DEMO_LOCKED_SESSION_PATHS: ReadonlySet<string> = new Set([
  '/change-password',
  '/set-password',
  '/change-email',
  '/update-user',
  '/delete-user',
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/unlink-account',
  '/email-otp/request-email-change',
  '/email-otp/change-email',
]);

/** Unauthenticated password-reset endpoints (the email in the body decides). */
export const DEMO_LOCKED_EMAIL_PATHS: ReadonlySet<string> = new Set([
  '/request-password-reset',
  '/forget-password/email-otp',
  '/email-otp/request-password-reset',
  '/email-otp/reset-password',
]);

export const DEMO_ACCOUNT_LOCKED_MESSAGE = 'This is a shared demo account: its password, email and profile cannot be changed.';

const bodyField = (body: unknown, key: string): unknown => (typeof body === 'object' && body !== null && key in body ? (body as Record<string, unknown>)[key] : undefined);

/** `before` hook; `isLocked(email)` is the seeded-demo check (src/db/demo-users.ts). */
export function demoAccountGuard(isLocked: (email: unknown) => boolean) {
  return createAuthMiddleware(async (ctx) => {
    const path = ctx.path;
    let locked = false;
    if (DEMO_LOCKED_EMAIL_PATHS.has(path)) {
      locked = isLocked(bodyField(ctx.body, 'email'));
    } else if (path === '/email-otp/send-verification-otp') {
      // A sign-in / verification code is fine; a reset or email-change code for a demo account is not.
      const type = bodyField(ctx.body, 'type');
      locked = (type === 'forget-password' || type === 'change-email') && isLocked(bodyField(ctx.body, 'email'));
    } else if (DEMO_LOCKED_SESSION_PATHS.has(path)) {
      const session = await getSessionFromCtx(ctx);
      locked = isLocked(session?.user.email);
    }
    if (locked) throw new APIError('FORBIDDEN', { message: DEMO_ACCOUNT_LOCKED_MESSAGE, code: 'DEMO_ACCOUNT_LOCKED' });
  });
}
