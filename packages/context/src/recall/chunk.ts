/**
 * Chunking: paragraph-first, then sentences, then a hard split, with a small overlap so a fact that
 * straddles a boundary is still in one chunk. Quoted reply history (`> …`, `On … wrote:`) is dropped:
 * it is already indexed as its own message. Emails here are short, so most are one chunk.
 */
import { looksLikeInjection } from '@ops/connector-composio/untrusted';
import { createHash } from 'node:crypto';
import type { RecallChunk, RecallDoc } from './model';

export interface ChunkOptions {
  /** Max characters per chunk (default 1,000: well inside a 512-token embedding window). */
  maxChars?: number;
  /** Characters of the previous chunk repeated at the start of the next (default 120). */
  overlap?: number;
}

const PO_NUMBER = /\bPO-\d{2,}\b/g;

/** PO numbers mentioned in a text (`PO-509`), unique, in order. */
export const poNumbersIn = (...texts: (string | null | undefined)[]): string[] => [...new Set(texts.flatMap((t) => t?.match(PO_NUMBER) ?? []))];

/** Control characters out, CRLF → LF, quoted history and the marker footer dropped, blank runs collapsed. */
export function cleanText(text: string): string {
  // eslint-disable-next-line no-control-regex
  const lines = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    if (/^On .{4,200} wrote:\s*$/.test(line.trim())) break;
    if (/^Ref: opsidem[0-9a-f]+\s*$/.test(line.trim())) continue;
    kept.push(line.trimEnd());
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const sentences = text.match(/[^.!?\n]+(?:[.!?]+|\n|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  const out: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (s.length > max) {
      if (cur) out.push(cur);
      cur = '';
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
      continue;
    }
    if (cur && cur.length + 1 + s.length > max) {
      out.push(cur);
      cur = s;
    } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

/** The tail of a chunk, starting at a word boundary, at most `n` characters. */
function tail(text: string, n: number): string {
  if (n <= 0 || text.length <= n) return n <= 0 ? '' : text;
  const t = text.slice(-n);
  const space = t.indexOf(' ');
  return space > 0 ? t.slice(space + 1) : t;
}

/** Splits cleaned text into chunks of at most `maxChars` (+ overlap). Empty text → []. */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const max = opts.maxChars ?? 1000;
  const overlap = Math.min(opts.overlap ?? 120, Math.floor(max / 4));
  const clean = cleanText(text);
  if (!clean) return [];
  const pieces = clean.split(/\n\s*\n/).flatMap((p) => splitLong(p.trim(), max)).filter(Boolean);
  const chunks: string[] = [];
  let cur = '';
  for (const p of pieces) {
    if (cur && cur.length + 2 + p.length > max) {
      chunks.push(cur);
      const carry = tail(cur, overlap);
      cur = carry ? `${carry}\n\n${p}` : p;
    } else cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** What gets embedded for a chunk: subject and author give the vector its topic and vendor; no dates. */
export function embedTextOf(doc: Pick<RecallDoc, 'title' | 'author' | 'vendorName'>, chunk: string): string {
  const from = doc.author ?? doc.vendorName;
  return [`Subject: ${doc.title}`, from ? `From: ${from}` : null, '', chunk].filter((l): l is string => l !== null).join('\n');
}

/** Hash of everything that affects a document's chunks, vectors or metadata. */
export function contentHashOf(doc: RecallDoc, chunkOpts: ChunkOptions = {}): string {
  return createHash('sha256')
    .update(JSON.stringify([doc.title, doc.text, doc.author, doc.vendorId, doc.vendorName, doc.poNumbers, doc.threadId, doc.messageId, doc.date, doc.ref, chunkOpts.maxChars ?? null, chunkOpts.overlap ?? null]))
    .digest('hex')
    .slice(0, 32);
}

/** A document's chunks with their flat metadata. */
export function chunkDoc(doc: RecallDoc, opts: ChunkOptions = {}): RecallChunk[] {
  const texts = chunkText(doc.text, opts);
  const docSuspicious = looksLikeInjection(`${doc.title}\n${doc.author ?? ''}\n${doc.text}`);
  const ts = Date.parse(doc.date);
  return texts.map((text, index) => ({
    id: `${doc.id}#${index}`,
    docId: doc.id,
    index,
    embedText: embedTextOf(doc, text),
    meta: {
      docId: doc.id,
      chunkIndex: index,
      source: doc.source,
      sourceId: doc.sourceId,
      vendorId: doc.vendorId ?? '',
      vendorName: doc.vendorName ?? '',
      title: doc.title,
      author: doc.author ?? '',
      text,
      poNumbers: doc.poNumbers,
      threadId: doc.threadId ?? '',
      messageId: doc.messageId ?? '',
      date: doc.date,
      ts: Number.isFinite(ts) ? ts : 0,
      ref: doc.ref,
      docSuspicious,
    },
  }));
}
