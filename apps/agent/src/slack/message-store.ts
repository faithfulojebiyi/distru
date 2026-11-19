import { and, eq, sql } from 'drizzle-orm';
import type { DB } from '../db/client';
import { slackMessage } from '../db/schema';
import type { SlackMessageRef, SlackMessageStore } from './approvals';

/** `slack_message` rows: one per (proposal, kind), so a retried post updates instead of duplicating. */
export class DrizzleSlackMessageStore implements SlackMessageStore {
  constructor(private readonly db: DB) {}

  async get(proposalId: string, kind: string): Promise<SlackMessageRef | null> {
    const [row] = await this.db
      .select({ channel: slackMessage.channel, ts: slackMessage.ts })
      .from(slackMessage)
      .where(and(eq(slackMessage.proposalId, proposalId), eq(slackMessage.kind, kind)));
    return row ?? null;
  }

  async put(proposalId: string, kind: string, ref: SlackMessageRef): Promise<void> {
    await this.db
      .insert(slackMessage)
      .values({ proposalId, kind, channel: ref.channel, ts: ref.ts })
      .onConflictDoUpdate({ target: [slackMessage.proposalId, slackMessage.kind], set: { channel: ref.channel, ts: ref.ts, updatedAt: sql`now()` } });
  }
}
