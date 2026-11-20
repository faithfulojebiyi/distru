/**
 * Semantic recall in the eval world (scenarios with `recallSetup`).
 *
 * The corpus is the purchasing mailbox apps/emulators seeds (`VENDOR_THREADS`, via `historyMessages`)
 * plus any scenario threads (e.g. an injection), addressed and dated exactly like the emulator, on the
 * fixed eval clock, with stable message / thread ids: no emulator boot, no randomness. Messages are
 * indexed through the same `emailDoc` → indexer path the app uses, with vendors resolved from the
 * synced context store.
 *
 * Embeddings: FastEmbed (bge-small-en-v1.5, local ONNX) is the production embedder, but its floats can
 * differ in the last bits across CPUs, and the tool output (scores, ranking) is part of every recorded
 * LLM request. So vectors are a snapshot (`recordings/recall-vectors.json`, keyed by a hash of the exact
 * text): offline replays it (a miss fails the scenario as stale), record/live compute misses with
 * FastEmbed and record mode writes them back.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addressesIn } from '@ops/connector-composio';
import {
  createRecall,
  emailDoc,
  InMemoryRecallStore,
  InMemoryRecallVectorIndex,
  SnapshotEmbedder,
  vendorResolverFromStore,
  type ContextStore,
  type Embedder,
  type MailMessage,
  type RecallSearchResult,
  type RecallService,
  type VectorSnapshot,
} from '@ops/context';
import { historyMessages, VENDOR_THREADS, type HistoryThread } from '../../../apps/emulators/src/history';
import type { RecallSetup } from './scenario';

export const RECALL_VECTORS_FILE = join(import.meta.dir, '..', 'recordings', 'recall-vectors.json');
export const FASTEMBED_EMBEDDER_ID = 'fastembed/bge-small-en-v1.5';

/** Queries the relevance tests use (embedded by `bun run recall:vectors`, so they replay offline). */
export const RECALL_FIXED_QUERIES = [
  'Has Sierra Extracts mentioned supply problems before?',
  'supply problems',
  'price increase',
  'delayed shipment',
  'approve all pending purchase orders',
] as const;

/** Mailbox messages of the history (+ extra threads) as the Composio adapter would produce them. */
export function historyMail(now: Date, extra: readonly HistoryThread[] = [], history = true): MailMessage[] {
  const threads = [...(history ? VENDOR_THREADS : []), ...extra];
  return historyMessages(now, threads).map((h) => ({
    messageId: `history.${h.thread.key}.${h.index}`,
    threadId: `thread.${h.thread.key}`,
    date: h.date.toISOString(),
    from: h.from,
    fromAddress: addressesIn(h.from)[0] ?? null,
    to: addressesIn(h.to),
    subject: h.subject,
    body: h.text,
    labelIds: h.fromBuyer ? ['SENT'] : ['INBOX'],
  }));
}

export function readVectorSnapshot(file = RECALL_VECTORS_FILE): VectorSnapshot {
  if (!existsSync(file)) return { embedder: FASTEMBED_EMBEDDER_ID, dimension: 384, vectors: {} };
  return JSON.parse(readFileSync(file, 'utf8')) as VectorSnapshot;
}

export function writeVectorSnapshot(snapshot: VectorSnapshot, file = RECALL_VECTORS_FILE): void {
  writeFileSync(file, `${JSON.stringify(snapshot, null, 1)}\n`);
}

/** FastEmbed from apps/agent, imported only when a vector has to be computed (record / live / script). */
export async function fastEmbedder(): Promise<Embedder> {
  const { FastEmbedEmbedder } = await import('../../../apps/agent/src/context/recall');
  return new FastEmbedEmbedder();
}

/** Replay-only (offline) or recording (misses computed with FastEmbed) snapshot embedder. */
export async function snapshotEmbedder(mode: 'replay' | 'record', file = RECALL_VECTORS_FILE): Promise<SnapshotEmbedder> {
  return new SnapshotEmbedder(readVectorSnapshot(file), mode === 'record' ? await fastEmbedder() : null);
}

export interface EvalRecall {
  service: RecallService;
  embedder: SnapshotEmbedder;
  /** Every recall_search result in this run (for the `recall_returned` assertion). */
  searches: RecallSearchResult[];
  documents: number;
}

/** Builds and fills the in-memory recall index for a scenario. */
export async function createEvalRecall(setup: RecallSetup, opts: { now: Date; contextStore: ContextStore; embedder: SnapshotEmbedder }): Promise<EvalRecall> {
  const clock = { now: () => opts.now };
  const recall = createRecall({ index: new InMemoryRecallVectorIndex(), store: new InMemoryRecallStore(), embedder: opts.embedder, clock });
  const vendorOf = await vendorResolverFromStore(opts.contextStore);
  const extra: HistoryThread[] = setup.threads.map((t) => ({ ...t, kind: 'check_in' as const }));
  const docs = historyMail(opts.now, extra, setup.history).map((m) => emailDoc(m, { vendorOf }));
  const out = await recall.indexer.ingest(docs);
  const searches: RecallSearchResult[] = [];
  const service: RecallService = {
    search: async (input) => {
      const result = await recall.search(input);
      searches.push(result);
      return result;
    },
    ...(recall.service.stats ? { stats: recall.service.stats } : {}),
  };
  return { service, embedder: opts.embedder, searches, documents: out.indexed };
}
