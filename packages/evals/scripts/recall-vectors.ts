/**
 * (Re)records the FastEmbed vector snapshot the recall evals and relevance tests replay offline
 * (`recordings/recall-vectors.json`): every chunk of the seeded mailbox, every scenario's extra recall
 * threads, and RECALL_FIXED_QUERIES. Vectors already in the snapshot are kept (keyed by text hash);
 * `--fresh` drops them first. LLM-chosen queries are added by `bun run evals:record`.
 *
 *   bun run --cwd packages/evals recall:vectors [-- --fresh]
 */
import '../src/env-defaults';
import { InMemoryContextStore, SnapshotEmbedder } from '@ops/context';
import { createEvalRecall, fastEmbedder, RECALL_FIXED_QUERIES, RECALL_VECTORS_FILE, readVectorSnapshot, writeVectorSnapshot } from '../src/recall';
import { SCENARIOS } from '../src/scenarios';
import { NOW } from '../src/world';

const fresh = process.argv.includes('--fresh');
const embedder = await fastEmbedder();
const start = fresh ? { embedder: embedder.id, dimension: embedder.dimension, vectors: {} } : readVectorSnapshot();
const recorder = new SnapshotEmbedder(start, embedder);
const before = Object.keys(start.vectors).length;
const threads = SCENARIOS.flatMap((s) => s.recallSetup?.threads ?? []);
const recall = await createEvalRecall({ history: true, threads }, { now: new Date(NOW), contextStore: new InMemoryContextStore(), embedder: recorder });
await recorder.embed([...RECALL_FIXED_QUERIES]);
const snapshot = recorder.snapshot();
writeVectorSnapshot(snapshot);
console.log(`${RECALL_VECTORS_FILE}: ${Object.keys(snapshot.vectors).length} vectors (${Object.keys(snapshot.vectors).length - before} new), ${recall.documents} documents, ${threads.length} extra thread(s), ${RECALL_FIXED_QUERIES.length} fixed queries, ${snapshot.embedder} ${snapshot.dimension}d`);
