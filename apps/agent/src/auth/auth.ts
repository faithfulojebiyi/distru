import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins';
import { db, schema } from '../db/client';
import { env } from '../env';

/**
 * Better Auth instance, mounted on the Hono app at /api/auth/*.
 *
 * - email + password only (demo users are seeded, sign-up stays open for local dev)
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
    // Bun.serve doesn't expose the peer IP to Better Auth; read it from the reverse proxy instead.
    ipAddress: { ipAddressHeaders: ['x-forwarded-for', 'x-real-ip'] },
  },
  plugins: [bearer()],
});

export type Auth = typeof auth;
