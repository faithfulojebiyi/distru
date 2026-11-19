import type { ConnectorContext } from '@ops/harness';
import { OutboxTransport, ResendTransport, type EmailTransport, type FetchLike } from './transport';

/** What the connector needs at `ctx.connectors.email`. */
export interface EmailClient {
  transport: EmailTransport;
  /** Sender, e.g. `Ops Agent <purchasing@dispensary.example>`. */
  from: string;
}

export type EmailCtx = ConnectorContext<'email', EmailClient>;

export const DEFAULT_FROM = 'Ops Agent <ops-agent@localhost>';

export function createEmailContext(client: Partial<EmailClient> = {}): EmailCtx {
  return { connectors: { email: { transport: client.transport ?? new OutboxTransport(), from: client.from ?? DEFAULT_FROM } } };
}

/**
 * `RESEND_API_KEY` set → Resend (sender `EMAIL_FROM`, required then); otherwise the in-memory mock
 * outbox, so local dev and tests never send real email.
 */
export function createEmailContextFromEnv(env: Record<string, string | undefined> = process.env, options: { fetch?: FetchLike } = {}): EmailCtx {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return createEmailContext({ from: env.EMAIL_FROM ?? DEFAULT_FROM });
  if (!env.EMAIL_FROM) throw new Error('EMAIL_FROM is required when RESEND_API_KEY is set');
  return createEmailContext({ transport: new ResendTransport({ apiKey, ...(options.fetch ? { fetch: options.fetch } : {}) }), from: env.EMAIL_FROM });
}

/** Lower-cased domain of an address (`Orders@Humboldt.example` → `humboldt.example`). */
export const domainOf = (address: string): string => address.slice(address.lastIndexOf('@') + 1).trim().toLowerCase();
