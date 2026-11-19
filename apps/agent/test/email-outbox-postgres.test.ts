/**
 * The vendor-email outbox persists in Postgres (`email_sent`): a new transport (a restarted process)
 * still finds a message by its idempotency key, so a retried send never delivers twice. Test DB only.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { OutboxTransport } from '@ops/connector-email';
import { inArray } from 'drizzle-orm';
import postgres from 'postgres';
import { db } from '../src/db/client';
import { emailSent } from '../src/db/schema';
import { DrizzleSentEmailRecord } from '../src/harness/email-record';

async function reachable(): Promise<boolean> {
  const probe = postgres(process.env.DATABASE_URL!, { max: 1, connect_timeout: 2, onnotice: () => {} });
  try {
    await probe`select 1 from email_sent limit 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 1 }).catch(() => {});
  }
}
const ok = await reachable();
const keys: string[] = [];

afterAll(async () => {
  if (ok && keys.length) await db.delete(emailSent).where(inArray(emailSent.idempotencyKey, keys));
});

describe.skipIf(!ok)('persistent outbox (Postgres)', () => {
  test('sent messages survive a restart; findByIdempotencyKey dedupes across processes', async () => {
    const key = `it-${crypto.randomUUID()}`;
    keys.push(key);
    const msg = { from: 'Purchasing <p@goldencoastdistro.com>', to: ['orders@humboldtfarms.com'], cc: [], subject: 'PO-1001', text: 'hi', html: '<p>hi</p>', idempotencyKey: key };
    const first = new OutboxTransport({ record: new DrizzleSentEmailRecord(db, 'outbox') });
    const { messageId } = await first.send(msg);
    expect(first.deliveries).toBe(1);

    const restarted = new OutboxTransport({ record: new DrizzleSentEmailRecord(db, 'outbox') });
    expect((await restarted.findByIdempotencyKey(key))?.messageId).toBe(messageId);
    expect((await restarted.send(msg)).messageId).toBe(messageId);
    expect(restarted.deliveries).toBe(0);
    expect((await restarted.get(messageId))?.to).toEqual(['orders@humboldtfarms.com']);
    expect((await restarted.list(5)).some((m) => m.messageId === messageId)).toBe(true);
  });
});
