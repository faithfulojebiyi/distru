/**
 * One-off backfill: proposals whose title is longer than 60 characters get the old title moved into
 * `summary` (when empty) and a short derived title. Idempotent (only touches long titles). Does not bump
 * `version` (a presentation-only change; no decision or execution state is involved).
 *
 *   bun run --cwd apps/agent titles:backfill
 */
import { sql as dsql } from 'drizzle-orm';
import { db, sql } from '../src/db/client';
import { proposal } from '../src/db/schema';
import { deriveShortTitle } from '../src/db/short-titles';

const rows = await db.select({ id: proposal.id, title: proposal.title, summary: proposal.summary }).from(proposal).where(dsql`length(${proposal.title}) > 60`);
for (const r of rows) {
  const title = deriveShortTitle(r.title!);
  await db.update(proposal).set({ title, summary: r.summary ?? r.title }).where(dsql`${proposal.id} = ${r.id}`);
  console.log(`${r.id}: "${title}"`);
}
console.log(`backfilled ${rows.length} proposal title(s)`);
await sql.end();
