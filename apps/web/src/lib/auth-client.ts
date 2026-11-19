import { emailOTPClient, inferAdditionalFields } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

import { apiUrl } from '../config/api-url';

/**
 * Better Auth runs inside the agent server, not here, so this is a pure client
 * of /api/auth/* on that origin.
 */
export const authClient = createAuthClient({
  baseURL: apiUrl,
  plugins: [
    // Sign-in by emailed code, email verification and password reset (clarkia's lib/auth-client.ts).
    emailOTPClient(),
    /**
     * Declared rather than inferred from the server's Auth type, which lives in
     * the agent app this package does not compile against.
     */
    inferAdditionalFields({
      user: {
        role: { type: 'string', required: false },
      },
    }),
  ],
});

export const { useSession } = authClient;

export type Role = 'operator' | 'approver';

/** Approvers can decide proposals; operators can only start runs and propose. */
export const canApprove = (role: unknown): boolean => role === 'approver';
