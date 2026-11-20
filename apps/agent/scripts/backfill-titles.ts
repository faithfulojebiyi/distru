/**
 * One-off backfills (idempotent, presentation-only: no `version` bump, no decision or execution state):
 *
 * 1. Proposals whose title is longer than 60 characters get the old title moved into `summary` (when
 *    empty) and a short derived title.
 * 2. Restock proposals stored before summaries / rationales were composed in code: a summary that repeats
 *    the title ("Restock: 14 POs (…) for …") becomes one human sentence, a bare "Restock N vendors" title
 *    gains its place, and a rationale that opens with "Triggered by …" is recomposed from the stored ops,
 *    meta and Planner summaries (names and lead times read from Distru).
 *
 *   bun run --cwd apps/agent titles:backfill
 */
import { createDistruContextFromEnv, vendorsTool } from '@ops/connector-distru';
import { asc, sql as dsql } from 'drizzle-orm';
import { z } from 'zod';
import { db, sql } from '../src/db/client';
import { rewriteRestockProposal } from '../src/db/backfill-restock';
import { proposal, proposalOp } from '../src/db/schema';
import { deriveShortTitle } from '../src/db/short-titles';

const rows = await db.select({ id: proposal.id, title: proposal.title, summary: proposal.summary }).from(proposal).where(dsql`length(${proposal.title}) > 60`);
for (const r of rows) {
  const title = deriveShortTitle(r.title!);
  await db.update(proposal).set({ title, summary: r.summary ?? r.title }).where(dsql`${proposal.id} = ${r.id}`);
  console.log(`${r.id}: "${title}"`);
}
console.log(`backfilled ${rows.length} proposal title(s)`);

const restock = await db
  .select({ id: proposal.id, title: proposal.title, summary: proposal.summary, rationale: proposal.rationale, meta: proposal.meta })
  .from(proposal)
  .where(dsql`${proposal.meta}->>'workflowId' = 'restock' and (${proposal.summary} ilike 'Restock:%' or ${proposal.summary} ~ '^[0-9]+ POs? \\(' or ${proposal.rationale} like 'Triggered by %' or ${proposal.title} ~ '^Restock [0-9]+ vendors$')`);
let rewritten = 0;
if (restock.length) {
  const ctx = createDistruContextFromEnv();
  const client = ctx.connectors.distru;
  const [locations, products, vendors] = await Promise.all([
    client.listAll(client.listLocations, {}),
    client.listAll(client.listProducts, {}),
    vendorsTool.run(ctx, {}),
  ]);
  const lookups = {
    locations: new Map(locations.map((l) => [l.id, l.name ?? l.id])),
    products: new Map(products.filter((p) => p.sku).map((p) => [p.id, p.sku!])),
    vendors: new Map(z.object({ vendors: z.array(z.object({ id: z.string(), name: z.string(), lead_time_days: z.number().nullable() })) }).parse(vendors).vendors.map((v) => [v.id, v])),
  };
  for (const p of restock) {
    const ops = await db
      .select({ opIndex: proposalOp.opIndex, action: proposalOp.action, input: proposalOp.input, summary: proposalOp.summary, value: proposalOp.value })
      .from(proposalOp)
      .where(dsql`${proposalOp.proposalId} = ${p.id}`)
      .orderBy(asc(proposalOp.opIndex));
    const patch = rewriteRestockProposal({ title: p.title, summary: p.summary, rationale: p.rationale, meta: (p.meta ?? {}) as Record<string, unknown> }, ops, lookups);
    if (!patch) continue;
    await db.update(proposal).set(patch).where(dsql`${proposal.id} = ${p.id}`);
    rewritten++;
    console.log(`${p.id}: ${Object.keys(patch).join(', ')}${patch.title ? ` → "${patch.title}"` : ''}`);
  }
}
console.log(`rewrote ${rewritten} restock proposal(s)`);
await sql.end();
