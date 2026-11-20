import type { UserRole } from './schema';

/**
 * The seeded demo accounts (src/db/seed.ts). With DEMO_MODE=1 they are shared by every visitor of a
 * public demo, so their password, email and profile are locked (src/auth/demo-guard.ts).
 */
export const DEMO_PASSWORD = 'demo-password';

export const DEMO_USERS: ReadonlyArray<{ email: string; name: string; role: UserRole }> = [
  { email: 'operator@demo.dev', name: 'Olivia Operator', role: 'operator' },
  { email: 'approver@demo.dev', name: 'Adam Approver', role: 'approver' },
];

const DEMO_EMAILS = new Set(DEMO_USERS.map((user) => user.email));

export const isDemoEmail = (email: unknown): boolean => typeof email === 'string' && DEMO_EMAILS.has(email.trim().toLowerCase());
