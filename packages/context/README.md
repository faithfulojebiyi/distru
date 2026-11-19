# @ops/context

The context layer: what the agents know beyond a single API call.

- **Relational context** (`src/sync`, `profile.ts`, `memory.ts`, `retrieval.ts`, `unified.ts`): an incremental
  Distru sync into a unified layer, vendor / product / customer profiles computed in code, memories learned from
  approvals with evidence and decay, and the `context` connector (`context_vendor_profile`, `context_for`, …).
  Structured and explainable; free text is deliberately never stored here.
- **Semantic recall** (`src/recall`): retrieval over unstructured text — vendor email, vendor replies, PO notes —
  behind ports, alongside (not instead of) the relational layer.

Stores: `InMemoryContextStore` / `InMemoryRecall*` for tests and evals; `@ops/context/drizzle` for Postgres
(`DrizzleContextStore`, `DrizzleRecallStore`, tables in schema `context`).

## Semantic recall

```ts
import { createRecall, emailDoc, purchaseNoteDocs, recallConnector, createRecallContext } from '@ops/context';

const recall = createRecall({ index, store, embedder }); // ports: RecallVectorIndex, RecallStore, Embedder
await recall.indexer.ingest(messages.map((m) => emailDoc(m, { vendorOf })));
await recall.search({ query: 'Sierra Extracts supply problems', vendorIds, since: '2026-10-01', limit: 5 });
const registry = new Registry({ connectors: [recallConnector] }); // read tool recall.search → recall_search
```

| Piece | What |
|---|---|
| `model.ts` | `RecallDoc` (one email / one PO's notes: source, source id, vendor, PO numbers, thread / message id, date, citation `ref`), flat chunk metadata |
| `chunk.ts` | paragraph → sentence → hard split (1,000 chars, 120 overlap); quoted reply history, `On … wrote:` tails and the idempotency footer dropped; embedded text is `Subject / From / chunk` (no dates, so vectors are stable) |
| `indexer.ts` | dedupe by document id (= source id; the last copy in a batch wins), skip unchanged content (hash + embedder id), a changed document replaces all its chunks, `force` re-embeds, `runIncremental(stream, fetch)` keeps a cursor that only advances after a successful ingest, `reset()` |
| `sources.ts` | `emailDoc` (Gmail id → `gmail:<id>`, so the trigger path and the mailbox pass are one document), `purchaseNoteDocs` (description / notes, Ops Agent marker stripped, boilerplate like "Restock from <vendor>" skipped), `vendorResolver` (exact address, then domain, over synced vendors) |
| `search.ts` | embed the query → nearest chunks filtered by vendor / source / date → best chunk per document → passages; every free-text field wrapped as `untrusted_text` with `@ops/connector-composio/untrusted` (same injection patterns as the Gmail connector); a passage is `suspicious` when its whole document looked like an injection; ≤ 8 passages, ≤ 800 chars each, ≤ 5,000 total |
| `embedder.ts` | `Embedder` port; `HashEmbedder` (deterministic lexical, tests / no-download fallback); `SnapshotEmbedder` (replays recorded vectors by text hash, records misses with a fallback) |
| `ports.ts` | `RecallVectorIndex`, `RecallStore`, in-memory adapters |
| `connector.ts` | `recallConnector` (`recall`, read-only) |

The app adapters (FastEmbed `bge-small-en-v1.5` embedder, `PgVector` index in schema `recall`, Composio Gmail
mailbox reader, Inngest functions, `GET /api/recall/search`) live in `apps/agent/src/context/recall.ts`.

The Distru sync hands raw purchase pages to `DistruSyncOptions.onFreeText` (best effort, never fails the sync),
which is how PO notes reach the recall index without the structured layer storing them.

```bash
bun test        # recall.test.ts: chunking, dedupe, incremental cursor, untrusted wrapping, filters, size bounds, scope check
CONTEXT_PG_TEST=1 bun test   # also DrizzleContextStore against Postgres
```
