/**
 * One semantic-recall indexing pass outside Inngest:
 *
 *   bun run --cwd apps/agent recall:index              # incremental: new mail since the cursor
 *   bun run --cwd apps/agent recall:index -- --reindex # forget everything, re-read and re-embed it all
 *
 * Sources: the purchasing mailbox through Composio Gmail (the emulator by default: `bun run dev:emulators`)
 * and Distru PO notes (a context sync pass hands every purchase to the index; `--reindex` forces a full
 * reconcile so every purchase is re-read). Needs Postgres with pgvector and, for FastEmbed, the model
 * (downloaded once to ~/.cache/mastra).
 */
import { sql } from '../src/db/client';
import { env } from '../src/env';
import { appContextStore, appContextSync, appRecall } from '../src/context';
import { indexMailbox, MAILBOX_STREAM } from '../src/context/recall';
import { syncAndProfile } from '../src/context/app-context';
import { appConnectors } from '../src/harness/registry';

const reindex = process.argv.includes('--reindex');
if (!env.RECALL_ENABLED) {
  console.error('RECALL_ENABLED=0: nothing to do');
  process.exit(1);
}
const started = Date.now();
console.log(`recall: embedder ${appRecall.indexer.embedder.id}${reindex ? ' (reindex: reset first)' : ''}`);
if (reindex) await appRecall.indexer.reset();

// PO notes come through the context sync (onFreeText); a reconcile re-reads every purchase.
const synced = await syncAndProfile(appContextSync, appContextStore, undefined, reindex ? { mode: 'reconcile' } : {});
console.log(`context sync ${synced.sync.status}: purchases fetched ${synced.sync.streams.purchases?.fetched ?? 0}`);

await appConnectors.start();
const status = appConnectors.composioStatus;
if (status.state !== 'connected') {
  console.warn(`composio ${status.state} (${status.detail}): mailbox not indexed`);
} else {
  const mail = await indexMailbox({ indexer: appRecall.indexer, contextStore: appContextStore, composio: () => appConnectors.composioClient() }, reindex ? { full: true, force: true } : {});
  console.log(`${MAILBOX_STREAM}: since ${mail.since ?? 'the beginning'} → ${mail.received} messages, ${mail.indexed} indexed, ${mail.unchanged} unchanged, ${mail.chunks} chunks`);
}
const stats = await appRecall.service.stats?.();
console.log(`recall index: ${stats?.documents ?? '?'} documents (${((Date.now() - started) / 1000).toFixed(1)}s)`);
const probe = await appRecall.search({ query: 'supply problems with the extraction line', limit: 3 });
for (const p of probe.passages) console.log(`  probe → ${p.score} ${p.date.slice(0, 10)} ${p.vendor?.name ?? '-'} ${p.subject?.untrusted_text ?? ''} [${p.ref}]${p.suspicious ? ' SUSPICIOUS' : ''}`);
await appConnectors.stop();
await sql.end({ timeout: 2 });
process.exit(0);
