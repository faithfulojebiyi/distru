/**
 * The `Embedder` port and two dependency-free adapters:
 *
 * - `HashEmbedder`: deterministic feature hashing (words + light stemming + character trigrams).
 *   No model, no network, identical on every machine. Lexical, not semantic: for unit tests and as an
 *   explicit offline fallback (`RECALL_EMBEDDER=hash`), never the production default.
 * - `SnapshotEmbedder`: replays vectors recorded from a real embedder, keyed by a hash of the exact
 *   text. Evals and relevance tests use it so a local ONNX model (whose floats can differ in the last
 *   bits across CPUs) still gives byte-identical tool output, which the LLM recordings depend on. In
 *   record mode a miss is computed by the fallback embedder and added to the snapshot.
 *
 * The production adapter (FastEmbed `bge-small-en-v1.5`, local ONNX, 384 dims) lives in apps/agent.
 */
import { createHash } from 'node:crypto';

export interface Embedder {
  /** Stable id (`fastembed/bge-small-en-v1.5`); a change re-embeds every document. */
  readonly id: string;
  readonly dimension: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export function l2normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  return n === 0 ? v : v.map((x) => x / n);
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function fnv(s: string, seed = 0x811c9dc5): number {
  let h = seed;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const STOP = new Set('a an and are as at be but by for from has have i in is it its of on or our so that the this to was we were will with you your'.split(' '));

/** `problems` → `problem`, `issues` → `issue`, `shipping` → `ship`… (crude, deterministic). */
export function stem(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

export class HashEmbedder implements Embedder {
  readonly id: string;
  constructor(readonly dimension = 256) {
    this.id = `hash/v1-${dimension}`;
  }

  embedOne(text: string): number[] {
    const v = new Array<number>(this.dimension).fill(0);
    const add = (feature: string, weight: number) => {
      const h = fnv(feature);
      v[h % this.dimension]! += (h & 0x80000000 ? -1 : 1) * weight;
    };
    const words = text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [];
    for (const w of words) {
      if (STOP.has(w)) continue;
      const s = stem(w);
      add(`w:${s}`, 1);
      const padded = `^${s}$`;
      for (let i = 0; i + 3 <= padded.length; i++) add(`t:${padded.slice(i, i + 3)}`, 0.3);
    }
    return l2normalize(v);
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }
}

// ── snapshots ──────────────────────────────────────────────────────────────────────────────────

/** Recorded vectors: `sha256(text)[0..24]` → base64 little-endian float32. */
export interface VectorSnapshot {
  embedder: string;
  dimension: number;
  vectors: Record<string, string>;
}

export const textKey = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 24);

export function encodeVector(v: readonly number[]): string {
  return Buffer.from(new Float32Array(v).buffer).toString('base64');
}

export function decodeVector(s: string): number[] {
  const buf = Buffer.from(s, 'base64');
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}

export class RecallSnapshotMissError extends Error {
  constructor(readonly texts: readonly string[]) {
    super(`No recorded embedding for ${texts.length} text(s) (first: ${JSON.stringify(texts[0]?.slice(0, 80))}); re-record the vector snapshot`);
    this.name = 'RecallSnapshotMissError';
  }
}

export class SnapshotEmbedder implements Embedder {
  readonly id: string;
  readonly dimension: number;
  #snapshot: VectorSnapshot;
  #dirty = false;
  readonly misses: string[] = [];

  /** `fallback` present = record mode (misses are embedded and added); absent = replay (misses throw). */
  constructor(
    snapshot: VectorSnapshot,
    private readonly fallback: Embedder | null = null,
  ) {
    if (fallback && snapshot.vectors && Object.keys(snapshot.vectors).length && fallback.id !== snapshot.embedder) {
      throw new Error(`snapshot was recorded with ${snapshot.embedder}, fallback is ${fallback.id}`);
    }
    this.#snapshot = { embedder: fallback?.id ?? snapshot.embedder, dimension: fallback?.dimension ?? snapshot.dimension, vectors: { ...snapshot.vectors } };
    this.id = this.#snapshot.embedder;
    this.dimension = this.#snapshot.dimension;
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  snapshot(): VectorSnapshot {
    const sorted = Object.fromEntries(Object.entries(this.#snapshot.vectors).sort(([a], [b]) => a.localeCompare(b)));
    return { ...this.#snapshot, vectors: sorted };
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    const missing = [...new Set(texts.filter((t) => !this.#snapshot.vectors[textKey(t)]))];
    if (missing.length) {
      if (!this.fallback) {
        this.misses.push(...missing);
        throw new RecallSnapshotMissError(missing);
      }
      const vs = await this.fallback.embed(missing);
      missing.forEach((t, i) => {
        this.#snapshot.vectors[textKey(t)] = encodeVector(vs[i]!);
      });
      this.#dirty = true;
    }
    return texts.map((t) => decodeVector(this.#snapshot.vectors[textKey(t)]!));
  }
}
