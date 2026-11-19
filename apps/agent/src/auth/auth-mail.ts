import { createHash } from 'node:crypto';
import { env } from '../env';

/**
 * Delivers Better Auth's emails (sign-in / verification / password-reset codes, reset links) through Resend.
 * Ported from clarkia libs/system/auth (otp-sender.ts + the emailOTP block of auth.ts): sent inline, not queued, so a
 * failure surfaces on the sign-in screen; an idempotency key per code, hashed so it never carries the secret.
 *
 * Where it goes:
 * - `RESEND_API_KEY` set → Resend at `RESEND_BASE_URL` (default https://api.resend.com): real mail.
 * - no key, not production → the Resend emulator in apps/emulators (`http://localhost:4700/resend`, any `re_` key),
 *   whose mailbox is readable at `GET /__emu/resend/messages?to=`. The code is also written to the server log.
 * - no key in production → the send fails (nothing would ever arrive).
 */
export type AuthEmailPurpose = 'sign-in' | 'email-verification' | 'forget-password' | 'change-email';

export const OTP_TTL_SECONDS = 300;

const EMULATOR_URL = 'http://localhost:4700/resend';
const EMULATOR_KEY = 're_emulator_ops_agent_local';

const target = (): { url: string; key: string; emulator: boolean } | null => {
  const base = process.env.RESEND_BASE_URL?.replace(/\/$/, '');
  if (env.RESEND_API_KEY) return { url: base ?? 'https://api.resend.com', key: env.RESEND_API_KEY, emulator: false };
  if (env.NODE_ENV === 'production') return null;
  return { url: base ?? EMULATOR_URL, key: EMULATOR_KEY, emulator: true };
};

const FROM = () => env.EMAIL_FROM ?? 'Ops Agent <auth@ops-agent.local>';

const COPY: Record<AuthEmailPurpose, { subject: string; lead: string }> = {
  'sign-in': { subject: 'Your Ops Agent sign-in code', lead: 'Use this code to sign in to Ops Agent.' },
  'email-verification': { subject: 'Confirm your email for Ops Agent', lead: 'Use this code to confirm your email and open your account.' },
  'forget-password': { subject: 'Reset your Ops Agent password', lead: 'Use this code to set a new password.' },
  'change-email': { subject: 'Confirm your new email for Ops Agent', lead: 'Use this code to confirm your new email address.' },
};

export const otpFingerprint = (email: string, otp: string): string =>
  createHash('sha256').update(`${email}:${otp}`).digest('hex').slice(0, 32);

const escape = (text: string) => text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char);

async function send(input: { to: string; subject: string; text: string; html: string; idempotencyKey: string }): Promise<void> {
  const where = target();
  if (!where) throw new Error('RESEND_API_KEY is not set, so auth emails cannot be sent');
  const response = await fetch(`${where.url}/emails`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${where.key}`,
      'content-type': 'application/json',
      'idempotency-key': input.idempotencyKey,
    },
    body: JSON.stringify({ from: FROM(), to: [input.to], subject: input.subject, text: input.text, html: input.html }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Resend ${response.status}${where.emulator ? ' (emulator)' : ''}: ${body.slice(0, 300)}`);
  }
}

/** A six-digit code for sign-in, email verification or password reset. */
export async function deliverAuthOtp(input: { email: string; otp: string; purpose: AuthEmailPurpose }): Promise<void> {
  const copy = COPY[input.purpose];
  const minutes = Math.round(OTP_TTL_SECONDS / 60);
  if (env.NODE_ENV !== 'production') console.info(`[auth] ${input.purpose} code for ${input.email}: ${input.otp}`);
  await send({
    to: input.email,
    subject: copy.subject,
    text: `${copy.lead}\n\n${input.otp}\n\nThe code expires in ${minutes} minutes. If you didn't ask for it, ignore this email.`,
    html: `<!doctype html><html><body style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5"><p>${escape(copy.lead)}</p><p style="font-size:24px;font-weight:600;letter-spacing:4px">${input.otp}</p><p style="color:#666">The code expires in ${minutes} minutes. If you didn't ask for it, ignore this email.</p></body></html>`,
    idempotencyKey: `${input.purpose}-otp/${otpFingerprint(input.email, input.otp)}`,
  });
}

/** Better Auth's link-based reset (`emailAndPassword.sendResetPassword`); the web app uses the code flow. */
export async function deliverResetLink(input: { email: string; url: string; token: string }): Promise<void> {
  if (env.NODE_ENV !== 'production') console.info(`[auth] password reset link for ${input.email}: ${input.url}`);
  await send({
    to: input.email,
    subject: COPY['forget-password'].subject,
    text: `Open this link to set a new password for Ops Agent:\n\n${input.url}\n\nIf you didn't ask for it, ignore this email.`,
    html: `<!doctype html><html><body style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5"><p>Open this link to set a new password for Ops Agent:</p><p><a href="${escape(input.url)}">Reset your password</a></p><p style="color:#666">If you didn't ask for it, ignore this email.</p></body></html>`,
    idempotencyKey: `reset-link/${otpFingerprint(input.email, input.token)}`,
  });
}
