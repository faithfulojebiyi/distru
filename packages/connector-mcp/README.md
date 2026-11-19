# @ops/connector-mcp

The **MCP bridge**: turns any MCP server (Streamable HTTP) into a governed harness connector.
Reads pass through; writes become `propose_*` actions that go through policy → human approval →
idempotent execute → (optional) read-back verify → audit. A write tool is never exposed, or callable,
as a read tool.

Built on `@modelcontextprotocol/client` 2.4.0 (the version already in the workspace).

```ts
import { Registry, createHarness } from '@ops/harness';
import { createMcpConnector, createDistruMcpConnector, mcpErrorClassifier } from '@ops/connector-mcp';

// Any MCP server
const sheets = await createMcpConnector({ id: 'sheets', system: 'spreadsheet', url, auth: { bearer: token } });

// Distru's MCP (DISTRU_MCP_URL defaults to https://mcp.distru.com/mcp, DISTRU_MCP_KEY = distru_mcp_…)
const distru = await createDistruMcpConnector({ readOnly: false });

const registry = Registry.fromConnectors([distru.connector, sheets.connector]);
const ctx = { connectors: { ...distru.context.connectors, ...sheets.context.connectors }, run: { intent: 'Restock at-risk SKUs' } };
const harness = createHarness({ registry, store, audit, policyRules, errors: mcpErrorClassifier });
```

`ctx.connectors.<id>` is the `McpBridgeClient`. `ctx.run` (optional) supplies `intent`,
`userSatisfactionEstimate` and `account` for servers that require them (Distru does).

## `createMcpConnector(config)`

| Option | Meaning |
|---|---|
| `id`, `system`, `description` | connector identity; names become `<id>.<tool>` → tools `<id>_<tool>` / `propose_<id>_<tool>` |
| `url`, `headers`, `auth: { bearer } \| { provider }` | Streamable HTTP endpoint and auth (static key or SDK `AuthProvider`/OAuth) |
| `readOnly`, `readOnlyHeader` | read-only mode sends the header (Distru: `x-distru-filter-tool-tags: read`) and builds **no** write actions; `callWrite` refuses |
| `classify` | override `(tool) => 'read' \| 'write' \| { kind, reaches?, destructive? } \| undefined` |
| `table` | known-tool table used when `_meta` is missing (presets) |
| `injectedFields`, `mapIntent` | args filled from run context and removed from the agent's `required` (default `intent`, `userSatisfactionEstimate`) |
| `stripPrefix` | `distru-` → local names `mutate_purchase_order` |
| `splitDeletes` | default true (see risk) |
| `tools: { [toolName]: hooks }` | per-tool `before`, `stamp`, `find`, `verify`, `recordIdOf`, `summarize`, `value`, `vendorIdsOf` |
| `freeTextKeys` | which result keys are wrapped as untrusted |

Returns `{ connector, client, context, tools, refresh(), close() }`. `tools` describes each bridged
tool (kind, names, risk, classification, `unverified`, `dedupeByExecutorOnly`, `looseInput`) for the UI.
`refresh()` re-lists tools and returns a new connector plus `added` / `removed` / `reclassified`;
rebuild the registry with it (registries copy connectors). Even with a stale registry, a tool that the
server now classifies as a write is refused at run time by `callRead`.

Health (`registry.health(ctx)`): connect + `tools/list`, detail `N tools (r read, w write)`.

## Classification (fail closed)

First match wins:

1. `classify` override
2. `_meta.distru.kind` / `_meta.distru.reaches` (our mock and the Distru convention; `irreversible` is honoured too)
3. preset table (Distru: all 114 tools from `docs/research/tool_table.md`)
4. MCP annotations: `readOnlyHint: true` → read; `destructiveHint: true` or `readOnlyHint: false` → write
5. name heuristics: `mutate|create|update|delete|adjust|send|email|split|move|finish|import|void|cancel|sync` → write
6. **default write** (a `get-thing` with no metadata is still a write)

Names containing `email`/`mail`/`sms` are assumed to reach `email`.

## Risk

- **high**: reaches `metrc`, `biotrack`, `quickbooks`, `leaflink`, `pos`, `trym` or `email`; destructive
  (`destructiveHint`, `_meta.distru.irreversible: true`); or a DELETE.
- **medium**: every other write. Reads have no risk. All writes require scope `propose`.
- Harness risk is static per action, so tools with an `action` enum containing DELETE (Distru
  `mutate-*`) are **split**: `<tool>` (CREATE/UPDATE, at the tool's risk) and `<tool>_delete` (high).
  An unqualified `destructiveHint` on such a tool, or `irreversible: ['DELETE']`, is attributed to DELETE.
  If the tool is high anyway (e.g. reaches QuickBooks), it stays one action.

## Write actions

- **input**: the tool's `inputSchema` converted with zod 4 `z.fromJSONSchema` (injected fields made
  optional, DELETE split applied). Unconvertible schemas fall back to "any object" (`looseInput`); the
  server still validates and a human approves the exact arguments. Unknown top-level keys are dropped.
- **loadBefore**: per-tool `before` resolver, else null.
- **plan**: the exact `tools/call` arguments, with injected fields filled from `mapIntent` when the
  schema declares them.
- **diff**: `before` vs payload (injected fields and `action` hidden); DELETE shows the record removed.
- **execute**: `callTool(payload)` with the idempotency key in `_meta["ops-agent/idempotency-key"]`,
  and optionally stamped into the arguments (`stamp: { field: 'description' }` appends
  `[ops-agent:idem=<key>]`, never clobbering text on a sparse UPDATE; or a custom function).
  `isError` results throw `McpToolError` (not retried); HTTP 429/5xx are retryable (`mcpErrorClassifier`).
- **findByIdempotencyKey**: per-tool `find` resolver, else null. Without one, dedupe relies on the
  harness executor record only (an executed op is never re-run, but a crash between the write and
  saving the op result can repeat the write).
- **verify**: per-tool `verify` resolver, else `{ ok: true, mismatches: [] }` (unverified). The tool
  description says "Result is unverified" and `bridge.tools[].unverified` is true so the UI can badge it.

### Undo hooks

`McpToolHooks.undo = { canUndo?(op), plan(h, op, result) → { current, target, args, summary?, value? } }`
gives a bridged write a harness `compensate`: the bridge calls the **same tool** with `args` (plus the
injected `intent` fields) and an idempotency key derived from the undone op; `args: null` = nothing
left to undo. Hooks stay read-only (`h.read`). `irreversible` explains tools without undo; split-out
`*_delete` actions are always irreversible. The Distru preset implements it for `distru-mutate-product`
UPDATEs: restore every field the update set to its `before` value (e.g. lift the allocation guard's
`maxMenuBuyerOrderQuantity` cap back to `null`).

## Read tools

Pass-through `tools/call` with injected fields filled. Output is deep-walked: string values of
free-text keys (`description`, `notes`, `message`, `body`, `title`, …) become
`{ untrusted_text, source, suspicious }`; other strings are made single-line and capped.

## Distru preset (`distruMcpPreset`, `createDistruMcpConnector`)

- `system: 'erp'`, `stripPrefix: 'distru-'`, read-only header `x-distru-filter-tool-tags: read`.
- Injected `intent` (run intent, else a description of the governed call), `userSatisfactionEstimate`
  (run value, else 5), `account` (from `ctx.run.account`, linked accounts).
- Table fallback for kind/reaches (38 writes; reaches Metrc, BioTrack, QuickBooks, LeafLink, POS, Trym, Email).
- `distru-mutate-purchase-order`: `before` = `distru-get-purchase-order` (items + charges) normalized to
  mutate argument names; key stamped in `description` (current notes fetched on a sparse UPDATE) or in a
  TEXT custom field when `idempotencyCustomFieldId` is set; `find` = custom-field `contains` search, else
  scan of the 10 most recently updated POs for the marker; `verify` = read back and `matchesExpected`
  (ids compared without their `com_`/`loc_` prefix, since Distru returns prefixed ids); DELETE verify
  = PO is gone; `value` = Σ quantity × price; `vendorIdsOf` = supplierId.
- `distru-mutate-task`: `before`/`verify` via `distru-search-tasks { ids }`; description marker; `find`
  scans the latest 50 tasks.
- `distru-mutate-product` (`productHooks`, used by the allocation guard to set
  `maxMenuBuyerOrderQuantity`, the per-buyer cap on one Distru Commerce menu order): `before` =
  `distru-get-product` normalized to mutate argument names (id kept as sent, so the diff shows only
  `maxMenuBuyerOrderQuantity: null → 24`; the recorded `before` is what an undo writes back); `verify`
  reads it back and compares every field the payload sets; no `find` (a product has no field to stamp
  a key into without touching customer-facing text, and a sparse UPDATE that sets values is idempotent
  by value); `moneyless`. CREATE/UPDATE is `mutate_product` (medium), DELETE is `mutate_product_delete` (high).
- `moneyless` hook flag: the tool moves no money, its ops count as 0 toward value rules (tasks,
  products). Unknown tools keep a null value, so value caps fail closed.
- Env: `DISTRU_MCP_URL` (default `https://mcp.distru.com/mcp`), `DISTRU_MCP_KEY` (`distru_mcp_…`).

```sh
bun test        # in-process MCP test server (SDK McpServer over Streamable HTTP on a random port)
bun run typecheck
```
