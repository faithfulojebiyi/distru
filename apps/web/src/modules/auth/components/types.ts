// Adapted from clarkia apps/dashboard/src/modules/auth/components/types.ts (the step types are copied as is).
/** What an emailed six-digit code proves: who is signing in, or that the email belongs to its new account. */
export type OtpPurpose = 'sign-in' | 'email-verification';

/** Where a password reset is: asking which email, then taking the code and the new password. */
export type PasswordResetStep = 'email' | 'code';

/** Which screen sign-in shows: the credentials form, a code to sign in, a code to confirm an unverified email, or
 * the forgot-password flow. */
export type SignInStep = 'credentials' | 'code' | 'verify-email' | 'reset';

/** Where sign-up is: the account details, then the emailed code that confirms the address. */
export type SignUpStep = 'details' | 'verify-email';

/** One row of the sign-in welcome panel: an at-risk item, what the agents are doing about it, and where it stands. */
export type WelcomeTask = {
  code: string;
  title: string;
  detail: string;
  tone: 'done' | 'working' | 'needs';
  status: string;
  typing?: boolean;
};
