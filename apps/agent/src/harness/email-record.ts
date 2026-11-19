import type { SentEmail, SentEmailRecord } from '@ops/connector-email';
import { desc, eq } from 'drizzle-orm';
import type { DB } from '../db/client';
import { emailSent } from '../db/schema';

type Row = typeof emailSent.$inferSelect;
const toSent = (r: Row): SentEmail => ({
  messageId: r.messageId,
  idempotencyKey: r.idempotencyKey,
  from: r.fromAddress,
  to: r.to,
  cc: r.cc,
  subject: r.subject,
  text: r.text,
  html: r.html,
  sentAt: r.sentAt.toISOString(),
});

/**
 * Sent vendor emails in Postgres (`email_sent`), for the mock outbox and Resend alike: the outbox
 * survives restarts and `findByIdempotencyKey` (the executor's dedupe before a retried send) still
 * finds a message sent by a previous process.
 */
export class DrizzleSentEmailRecord implements SentEmailRecord {
  constructor(
    private readonly db: DB,
    private readonly transport: string,
  ) {}

  async put(m: SentEmail): Promise<void> {
    const values = { messageId: m.messageId, transport: this.transport, fromAddress: m.from, to: m.to, cc: m.cc, subject: m.subject, text: m.text, html: m.html, sentAt: new Date(m.sentAt) };
    await this.db.insert(emailSent).values({ idempotencyKey: m.idempotencyKey, ...values }).onConflictDoUpdate({ target: emailSent.idempotencyKey, set: values });
  }

  async byKey(idempotencyKey: string): Promise<SentEmail | null> {
    const [row] = await this.db.select().from(emailSent).where(eq(emailSent.idempotencyKey, idempotencyKey));
    return row ? toSent(row) : null;
  }

  async byId(messageId: string): Promise<SentEmail | null> {
    const [row] = await this.db.select().from(emailSent).where(eq(emailSent.messageId, messageId));
    return row ? toSent(row) : null;
  }

  async recent(limit: number): Promise<SentEmail[]> {
    return (await this.db.select().from(emailSent).orderBy(desc(emailSent.sentAt)).limit(limit)).map(toSent);
  }
}
