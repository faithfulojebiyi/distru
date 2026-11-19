/**
 * Semantic recall over unstructured text: the shapes. A **document** is one piece of free text with
 * provenance (one email, the notes of one PO, one vendor reply); it is split into **chunks** that are
 * embedded and stored in a vector index with flat metadata (so any vector store's metadata filter
 * can narrow by vendor, source or date). Everything indexed is untrusted external text: it is only
 * ever returned to an agent wrapped as `untrusted_text` with a `suspicious` flag.
 */
import { z } from 'zod';

/**
 * - `email`: a message in the purchasing mailbox (Composio Gmail reads), either direction.
 * - `vendor_reply`: a vendor's message indexed as it arrived (Composio Gmail trigger).
 * - `po_note`: a Distru purchase order's internal / external notes (from the context sync).
 *
 * Copilot conversation turns are not indexed here: the Ops Lead's Mastra Memory recalls them itself
 * (`semanticRecall`, same pgvector database).
 */
export const RecallSourceSchema = z.enum(['email', 'vendor_reply', 'po_note']);
export type RecallSource = z.infer<typeof RecallSourceSchema>;

export const RecallDocSchema = z.object({
  /** `<source>:<sourceId>`; re-ingesting the same id replaces the document (dedupe by source id). */
  id: z.string().min(1),
  source: RecallSourceSchema,
  /** Gmail message id, Distru purchase id, … */
  sourceId: z.string().min(1),
  /** Subject, or `PO-512 notes`. Untrusted. */
  title: z.string(),
  /** The free text itself. Untrusted. */
  text: z.string(),
  /** Display author (`"Priya Nair (Sierra Extracts Co.)" <orders@…>`). Untrusted. */
  author: z.string().nullable(),
  vendorId: z.string().nullable(),
  vendorName: z.string().nullable(),
  /** PO numbers mentioned in the title or text (`PO-509`). */
  poNumbers: z.array(z.string()),
  threadId: z.string().nullable(),
  messageId: z.string().nullable(),
  /** When the text was written (ISO-8601). */
  date: z.string(),
  /** Where it came from, as a citation: `gmail:thread/<id>#<message>` or `distru:purchase/<id>`. */
  ref: z.string(),
});
export type RecallDoc = z.infer<typeof RecallDocSchema>;

/** Flat chunk metadata stored next to the vector (filterable: vendorId, source, ts). */
export interface RecallChunkMeta {
  docId: string;
  chunkIndex: number;
  source: RecallSource;
  sourceId: string;
  /** Empty string when unknown (flat metadata, filterable with `$in`). */
  vendorId: string;
  vendorName: string;
  title: string;
  author: string;
  text: string;
  poNumbers: string[];
  threadId: string;
  messageId: string;
  date: string;
  /** `date` in epoch ms (numeric range filters). */
  ts: number;
  ref: string;
  /** The whole document looked like a prompt injection (a chunk inherits it). */
  docSuspicious: boolean;
}

export interface RecallChunk {
  /** `<docId>#<index>`. */
  id: string;
  docId: string;
  index: number;
  /** What is embedded: `Subject: …\nFrom: …\n\n<chunk>` (no dates, so vectors are stable). */
  embedText: string;
  meta: RecallChunkMeta;
}

/** Bookkeeping per indexed document (dedupe + incremental re-index). */
export interface RecallDocRecord {
  id: string;
  source: RecallSource;
  sourceId: string;
  contentHash: string;
  chunkCount: number;
  embedder: string;
  date: string;
  indexedAt: string;
}

/** Per-stream cursor of an incremental recall source (e.g. the Gmail `after:` bound). */
export interface RecallCursor {
  stream: string;
  cursorAt: string;
  lastRunAt: string;
  lastStats: Record<string, number> | null;
}

/** Filter a vector index applies before ranking. */
export interface RecallFilter {
  vendorIds?: readonly string[];
  sources?: readonly RecallSource[];
  /** Only text written at or after this instant (epoch ms). */
  sinceTs?: number;
}

export interface RecallMatch {
  id: string;
  /** Cosine similarity, higher is closer. */
  score: number;
  meta: RecallChunkMeta;
}
