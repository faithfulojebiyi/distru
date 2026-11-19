import { defineConnector, type ErrorClassifier } from '@ops/harness';
import { outboxRecentTool } from './outbox-recent';
import { sendVendorPoAction } from './send-vendor-po';
import type { EmailCtx } from './shared';
import { isRetryableEmailError, ResendApiError } from './transport';

/**
 * Email connector. Registered names: `email.send_vendor_po` (tool `propose_email_send_vendor_po`,
 * risk high) and `email.outbox_recent` (tool `email_outbox_recent`). Needs `ctx.connectors.email`
 * (see `createEmailContext` / `createEmailContextFromEnv`).
 */
export const emailConnector = defineConnector<EmailCtx>({
  id: 'email',
  system: 'email',
  description: 'Outgoing email to vendors (purchase orders). Every send needs human approval; no undo.',
  readTools: [outboxRecentTool],
  actions: [sendVendorPoAction],
  health: async (ctx) => {
    const { transport, from } = ctx.connectors.email;
    return { ok: Boolean(from), detail: `${transport.name} transport, from ${from}` };
  },
});

/** Harness `ErrorClassifier` for email: Resend 429/5xx retryable, honouring Retry-After. */
export const emailErrorClassifier: ErrorClassifier = {
  isRetryable: isRetryableEmailError,
  retryAfterMs: (err) => (err instanceof ResendApiError && err.retryAfterSeconds !== undefined ? err.retryAfterSeconds * 1000 : undefined),
};

export { createEmailContext, createEmailContextFromEnv, domainOf, DEFAULT_FROM, type EmailClient, type EmailCtx } from './shared';
export {
  OutboxTransport,
  ResendTransport,
  ResendApiError,
  InMemorySentEmailRecord,
  isRetryableEmailError,
  OutgoingEmailSchema,
  type EmailTransport,
  type OutgoingEmail,
  type SentEmail,
  type SentEmailRecord,
  type OutboxOptions,
  type ResendOptions,
} from './transport';
export {
  sendVendorPoAction,
  SendVendorPoInputSchema,
  VendorPoEmailSchema,
  planVendorPoEmail,
  emailDiff,
  recipientDomains,
  type SendVendorPoInput,
  type VendorPoEmail,
} from './send-vendor-po';
export { emailRecipientDomainsRule, EMAIL_RECIPIENT_DOMAINS_RULE } from './policy';
export { outboxRecentTool, OutboxRecentInput, OutboxRecentOutput, type OutboxRecent } from './outbox-recent';
export { markdownToHtml, markdownToText, escapeHtml } from './render';
export { untrusted, looksLikeInjection, UntrustedTextSchema, type UntrustedText } from './untrusted';
