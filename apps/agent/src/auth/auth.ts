import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer, emailOTP } from 'better-auth/plugins';
import { db, schema } from '../db/client';
import { env } from '../env';
import { OTP_TTL_SECONDS, deliverAuthOtp, deliverResetLink } from './auth-mail';

if (env.NODE_ENV === 'production' && env.TRUSTED_IP_HEADERS.length === 0) {
  console.warn('[auth] TRUSTED_IP_HEADER is not set: client IPs are unknown, so auth rate limits share one bucket. Set it to the header your platform / proxy sets (e.g. fly-client-ip or x-forwarded-for).');
}

/**
 * Better Auth instance, mounted on the Hono app at /api/auth/*.
 *
 * - email + password, plus emailed six-digit codes (emailOTP, ported from clarkia libs/system/auth/auth.ts): sign in
 *   by code, confirm a new account's email (required before its first session), and reset a password. Codes go through
 *   Resend, or the Resend emulator in dev (see auth-mail.ts). Demo users are seeded verified.
 * - `role` is a server-owned user field: `input: false` means clients can never set it on sign-up
 * - `bearer()` lets non-browser clients (scripts, MCP) send `Authorization: Bearer <session token>`
 */
export const auth = betterAuth({
  appName: 'Ops Agent',
  baseURL: env.BETTER_AUTH_URL,
  basePath: '/api/auth',
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: env.WEB_ORIGIN,
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: env.NODE_ENV === 'production',
    requireEmailVerification: true,
    sendResetPassword: async ({ user, url, token }) => {
      await deliverResetLink({ email: user.email, url, token });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
  },
  user: {
    additionalFields: {
      role: {
        type: ['operator', 'approver'],
        required: false,
        defaultValue: 'operator',
        input: false,
      },
    },
  },
  advanced: {
    database: { generateId: () => crypto.randomUUID() },
    // Bun.serve doesn't expose the peer IP to Better Auth, so it comes from a header, but only one we trust:
    // TRUSTED_IP_HEADER (e.g. fly-client-ip, or x-forwarded-for set by our own proxy). Outside production the
    // default is x-forwarded-for / x-real-ip; in production none unless configured (a client could forge it).
    ipAddress: { ipAddressHeaders: env.TRUSTED_IP_HEADERS },
  },
  plugins: [
    bearer(),
    emailOTP({
      otpLength: 6,
      expiresIn: OTP_TTL_SECONDS,
      // Sent inline, not queued: a late code is worthless and a queue would hide the failure from sign-in.
      // Email verification uses the same 6-digit code as sign-in, entered on the sign-up and sign-in pages.
      overrideDefaultEmailVerification: true,
      // Sign-in by code never creates an account; sign-up does (and needs the email confirmed).
      disableSignUp: true,
      async sendVerificationOTP({ email, otp, type }) {
        try {
          await deliverAuthOtp({ email, otp, purpose: type });
        } catch (error) {
          console.error(`[auth] failed to send a ${type} code: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
      },
    }),
  ],
});

export type Auth = typeof auth;

/** Email sign-in returning the session token and Set-Cookie headers (used by the Studio login form in dev). */
export async function signInWithEmail(email: string, password: string): Promise<{ token: string; cookies: string[] }> {
  const { headers, response } = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
  return { token: response.token, cookies: headers.getSetCookie() };
}
