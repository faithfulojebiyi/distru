/**
 * Semantic recall (packages/context `recall`) wired into the app:
 *
 * - **Embedder**: FastEmbed `bge-small-en-v1.5` (@mastra/fastembed): a local ONNX model, 384 dims, no
 *   API key, no per-call cost, runs offline after a one-time ~30 MB model download (cached under
 *   `~/.cache/mastra`). `RECALL_EMBEDDER=hash` swaps in the dependency-free lexical `HashEmbedder`
 *   (no download; for constrained environments).
 * - **Vectors**: `PgVector` (@mastra/pg) on the app's Postgres (pgvector extension), schema `recall`,
 *   index `recall_chunks_<dims>` (HNSW, cosine). Kept out of `context` because drizzle-kit owns that
 *   schema and would drop tables it does not know.
 * - **Ledger + cursors**: `DrizzleRecallStore` (`context.recall_documents`, `context.recall_cursors`).
 * - **Sources**: the purchasing mailbox through Composio Gmail (`GMAIL_FETCH_EMAILS`, incremental
 *   `after:` cursor, paged by `before:`), single vendor replies as the Gmail trigger delivers them, and
 *   Distru PO notes handed over by the context sync (`onFreeText`).
 *
 * Copilot conversation turns are recalled by Mastra Memory itself (`opsLeadMemory`: semanticRecall on
 * the same pgvector database, schema `mastra`).
 */
import { Memory } from '@mastra/memory';
import { PgVector } from '@mastra/pg';
import { addressesIn, GmailNewMessageEventSchema, messagesOf, RawGmailMessageSchema, runComposioTool, stripMarker, type ComposioToolsClient } from '@ops/connector-composio';
import {
  createRecall,
  emailDoc,
  HashEmbedder,
  MailMessageSchema,
  purchaseNoteDocs,
  vendorResolverFromStore,
  type ContextStore,
  type Embedder,
  type MailMessage,
  type Recall,
  type RecallFilter,
  type RecallIndexer,
  type RecallMatch,
  type RecallStore,
  type RecallVectorIndex,
  type RecallVectorRow,
  type RecallChunkMeta,
} from '@ops/context';

// ── embedders ────────────────────────────────────────────────────────────────────────────────

export const FASTEMBED_ID = 'fastembed/bge-small-en-v1.5';
export const FASTEMBED_DIMENSION = 384;

/** @mastra/fastembed, imported on first use (its ONNX runtime and tokenizer are native modules). */
export const loadFastembed = async () => (await import('@mastra/fastembed')).fastembed;

/** FastEmbed (local ONNX) behind the `Embedder` port. The model loads lazily on the first call. */
export class FastEmbedEmbedder implements Embedder {
  readonly id = FASTEMBED_ID;
  readonly dimension = FASTEMBED_DIMENSION;

  async embed(texts: readonly string[]): Promise<number[][]> {
    const fastembed = await loadFastembed();
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const { embeddings } = await fastembed.doEmbed({ values: texts.slice(i, i + 64) as string[] });
      out.push(...embeddings.map((v) => Array.from(v)));
    }
    return out;
  }
}

export type RecallEmbedderKind = 'fastembed' | 'hash';

export const createEmbedder = (kind: RecallEmbedderKind): Embedder => (kind === 'hash' ? new HashEmbedder() : new FastEmbedEmbedder());

// ── PgVector adapter ─────────────────────────────────────────────────────────────────────────

/** @mastra/pg's filter type (not exported by name). */
type PgFilter = NonNullable<Parameters<PgVector['query']>[0]['filter']>;

export function pgFilterOf(filter: RecallFilter | undefined): PgFilter | undefined {
  const parts: Record<string, unknown>[] = [];
  if (filter?.vendorIds?.length) parts.push({ vendorId: { $in: [...filter.vendorIds] } });
  if (filter?.sources?.length) parts.push({ source: { $in: [...filter.sources] } });
  if (filter?.sinceTs !== undefined) parts.push({ ts: { $gte: filter.sinceTs } });
  if (!parts.length) return undefined;
  return (parts.length === 1 ? parts[0] : { $and: parts }) as PgFilter;
}

/** `RecallVectorIndex` on @mastra/pg's `PgVector` (cosine, HNSW, btree indexes on docId / vendorId). */
export class PgVectorRecallIndex implements RecallVectorIndex {
  #indexName: string | null = null;

  constructor(
    readonly vector: PgVector,
    private readonly prefix = 'recall_chunks',
  ) {}

  get indexName(): string {
    if (!this.#indexName) throw new Error('PgVectorRecallIndex: ensure() first');
    return this.#indexName;
  }

  async ensure(dimension: number): Promise<void> {
    const indexName = `${this.prefix}_${dimension}`;
    if (this.#indexName === indexName) return;
    await this.vector.createIndex({ indexName, dimension, metric: 'cosine', indexConfig: { type: 'hnsw' }, metadataIndexes: ['docId', 'vendorId'] });
    this.#indexName = indexName;
  }

  async upsert(rows: readonly RecallVectorRow[]): Promise<void> {
    if (!rows.length) return;
    await this.vector.upsert({ indexName: this.indexName, ids: rows.map((r) => r.id), vectors: rows.map((r) => r.vector), metadata: rows.map((r) => ({ ...r.meta })) });
  }

  async deleteDocs(docIds: readonly string[]): Promise<void> {
    if (!docIds.length) return;
    await this.vector.deleteVectors({ indexName: this.indexName, filter: { docId: { $in: [...docIds] } } });
  }

  async query({ vector, topK, filter }: { vector: number[]; topK: number; filter?: RecallFilter }): Promise<RecallMatch[]> {
    const pgFilter = pgFilterOf(filter);
    const rows = await this.vector.query({ indexName: this.indexName, queryVector: vector, topK, ...(pgFilter ? { filter: pgFilter } : {}) });
    return rows.map((r) => ({ id: r.id, score: r.score, meta: r.metadata as RecallChunkMeta }));
  }

  async clear(): Promise<void> {
    if (this.#indexName) await this.vector.truncateIndex({ indexName: this.#indexName });
  }
}

export function createPgRecall(opts: { connectionString: string; store: RecallStore; embedder: Embedder }): Recall & { index: PgVectorRecallIndex } {
  const index = new PgVectorRecallIndex(new PgVector({ id: 'ops-recall', connectionString: opts.connectionString, schemaName: 'recall' }));
  return { ...createRecall({ index, store: opts.store, embedder: opts.embedder }), index };
}

// ── Ops Lead conversation memory (Mastra semanticRecall) ────────────────────────────────────

/**
 * Copilot memory: the last 20 messages of the thread plus Mastra's semantic recall over this
 * operator's earlier Copilot turns (all their threads: `scope: 'resource'`), embedded locally with
 * FastEmbed into pgvector (schema `mastra`, next to Mastra's storage tables).
 */
export function opsLeadMemory(connectionString: string, embedder: Awaited<ReturnType<typeof loadFastembed>>): Memory {
  return new Memory({
    vector: new PgVector({ id: 'ops-memory-vector', connectionString, schemaName: 'mastra' }),
    embedder,
    embeddingDimension: FASTEMBED_DIMENSION,
    options: { lastMessages: 20, semanticRecall: { topK: 3, messageRange: 1, scope: 'resource', indexConfig: { type: 'hnsw', metric: 'cosine' } } },
  });
}

// ── Composio Gmail → MailMessage ─────────────────────────────────────────────────────────────

/** Composio's Gmail message view → `MailMessage` (full plain-text body, Ops Agent marker stripped). */
export function mailFromComposio(raw: unknown): MailMessage | null {
  const parsed = RawGmailMessageSchema.safeParse(raw);
  if (!parsed.success) return null;
  const m = parsed.data;
  const messageId = m.messageId ?? m.id;
  if (!messageId) return null;
  const date = m.messageTimestamp && Number.isFinite(Date.parse(m.messageTimestamp)) ? new Date(m.messageTimestamp).toISOString() : new Date(0).toISOString();
  return MailMessageSchema.parse({
    messageId,
    threadId: m.threadId ?? null,
    date,
    from: m.sender ?? null,
    fromAddress: addressesIn(m.sender)[0] ?? null,
    to: addressesIn(m.to),
    subject: m.subject ?? m.preview?.subject ?? null,
    body: stripMarker(m.messageText ?? m.preview?.body ?? ''),
    labelIds: m.labelIds ?? [],
  });
}

export interface MailboxPage {
  messages: MailMessage[];
  /** The next incremental pass reads from here (minus the overlap). */
  cursorAt: string;
  queries: string[];
}

/**
 * Every message of the connected mailbox written after `since` (minus `overlapMs`), newest first.
 * Pages by narrowing `before:` to the oldest message seen (works on Gmail and the emulator alike,
 * whether or not the provider honours page tokens); duplicates across pages are dropped by id.
 */
export async function fetchMailboxSince(client: ComposioToolsClient, since: string | null, opts: { now: Date; pageSize?: number; maxPages?: number; overlapMs?: number }): Promise<MailboxPage> {
  const pageSize = opts.pageSize ?? 50;
  const maxPages = opts.maxPages ?? 40;
  const afterSec = since ? Math.floor((Date.parse(since) - (opts.overlapMs ?? 10 * 60_000)) / 1000) : null;
  const seen = new Map<string, MailMessage>();
  const queries: string[] = [];
  let beforeSec: number | null = null;
  for (let page = 0; page < maxPages; page++) {
    const query = [afterSec !== null ? `after:${afterSec}` : null, beforeSec !== null ? `before:${beforeSec}` : null, '-in:drafts'].filter(Boolean).join(' ');
    queries.push(query);
    const data = await runComposioTool(client, 'GMAIL_FETCH_EMAILS', { query, max_results: pageSize });
    const batch = messagesOf(data).flatMap((m) => mailFromComposio(m) ?? []);
    let added = 0;
    for (const m of batch) {
      if (seen.has(m.messageId)) continue;
      seen.set(m.messageId, m);
      added++;
    }
    if (batch.length < pageSize || added === 0) break;
    const oldest = Math.min(...batch.map((m) => Date.parse(m.date)));
    beforeSec = Math.floor(oldest / 1000) + 1;
  }
  return { messages: [...seen.values()], cursorAt: opts.now.toISOString(), queries };
}

// ── passes ───────────────────────────────────────────────────────────────────────────────────

export const MAILBOX_STREAM = 'gmail:mailbox';

export interface RecallPassDeps {
  indexer: RecallIndexer;
  contextStore: ContextStore;
  composio: () => ComposioToolsClient;
  now?: () => Date;
}

/** One incremental pass over the mailbox (cron); `full` re-reads everything (reindex). */
export async function indexMailbox(deps: RecallPassDeps, opts: { full?: boolean; force?: boolean } = {}) {
  const vendorOf = await vendorResolverFromStore(deps.contextStore);
  const now = deps.now?.() ?? new Date();
  return deps.indexer.runIncremental(
    MAILBOX_STREAM,
    async (since) => {
      const page = await fetchMailboxSince(deps.composio(), opts.full ? null : since, { now });
      return { docs: page.messages.map((m) => emailDoc(m, { vendorOf })), cursorAt: page.cursorAt };
    },
    opts.force ? { force: true } : {},
  );
}

/** A Gmail trigger event (`composio/gmail.new_message`): read the message and index it as it arrives. */
export async function indexIncomingMessage(deps: RecallPassDeps, event: unknown) {
  const e = GmailNewMessageEventSchema.parse(event);
  const raw = await runComposioTool(deps.composio(), 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', { message_id: e.data.messageId });
  const mail = mailFromComposio(raw);
  if (!mail) return { indexed: 0, reason: 'message not readable' };
  const vendorOf = await vendorResolverFromStore(deps.contextStore);
  const doc = emailDoc(mail, { vendorOf, source: vendorOf([mail.fromAddress]) ? 'vendor_reply' : 'email' });
  const out = await deps.indexer.ingest([doc]);
  return { ...out, docId: doc.id, vendorId: doc.vendorId };
}

/** Raw Distru purchases (the sync's `onFreeText`) → PO note documents. */
export async function indexPurchaseNotes(deps: Pick<RecallPassDeps, 'indexer' | 'contextStore'>, raws: readonly unknown[], now: string) {
  const vendors = await deps.contextStore.list('company');
  const vendorNames = new Map(vendors.map((c) => [c.sourceId, c.name] as const));
  return deps.indexer.ingest(purchaseNoteDocs(raws, { vendorNames, now }));
}
