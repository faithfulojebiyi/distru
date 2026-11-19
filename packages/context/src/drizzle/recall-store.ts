/** `RecallStore` on Postgres via Drizzle (`context.recall_documents`, `context.recall_cursors`). */
import { count, eq, inArray, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { RecallCursor, RecallDocRecord } from '../recall/model';
import type { RecallStore } from '../recall/ports';
import * as t from './schema';

const isoOf = (v: string): string => new Date(v.includes('T') ? v : v.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')).toISOString();

export class DrizzleRecallStore<H extends PgQueryResultHKT, S extends Record<string, unknown>> implements RecallStore {
  constructor(private readonly db: PgDatabase<H, S>) {}

  async getDocs(ids: readonly string[]): Promise<Map<string, RecallDocRecord>> {
    if (!ids.length) return new Map();
    const out = new Map<string, RecallDocRecord>();
    for (let i = 0; i < ids.length; i += 1000) {
      const rows = await this.db.select().from(t.recallDocuments).where(inArray(t.recallDocuments.id, ids.slice(i, i + 1000) as string[]));
      for (const r of rows) out.set(r.id, { ...r, date: isoOf(r.date), indexedAt: isoOf(r.indexedAt) });
    }
    return out;
  }

  async putDocs(records: readonly RecallDocRecord[]): Promise<void> {
    for (let i = 0; i < records.length; i += 500) {
      const chunk = records.slice(i, i + 500);
      await this.db
        .insert(t.recallDocuments)
        .values(chunk.map((r) => ({ ...r })))
        .onConflictDoUpdate({
          target: t.recallDocuments.id,
          set: {
            source: sql.raw('excluded."source"'),
            sourceId: sql.raw('excluded."source_id"'),
            contentHash: sql.raw('excluded."content_hash"'),
            chunkCount: sql.raw('excluded."chunk_count"'),
            embedder: sql.raw('excluded."embedder"'),
            date: sql.raw('excluded."date"'),
            indexedAt: sql.raw('excluded."indexed_at"'),
          },
        });
    }
  }

  async countDocs(): Promise<number> {
    const [r] = await this.db.select({ n: count() }).from(t.recallDocuments);
    return Number(r?.n ?? 0);
  }

  async clearDocs(): Promise<void> {
    await this.db.delete(t.recallDocuments);
  }

  async getCursor(stream: string): Promise<RecallCursor | null> {
    const [r] = await this.db.select().from(t.recallCursors).where(eq(t.recallCursors.stream, stream));
    return r ? { stream: r.stream, cursorAt: isoOf(r.cursorAt), lastRunAt: isoOf(r.lastRunAt), lastStats: r.lastStats ?? null } : null;
  }

  async putCursor(cursor: RecallCursor): Promise<void> {
    await this.db
      .insert(t.recallCursors)
      .values(cursor)
      .onConflictDoUpdate({ target: t.recallCursors.stream, set: { cursorAt: cursor.cursorAt, lastRunAt: cursor.lastRunAt, lastStats: cursor.lastStats } });
  }

  async clearCursors(): Promise<void> {
    await this.db.delete(t.recallCursors);
  }
}
