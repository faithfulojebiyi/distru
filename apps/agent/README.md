# @ops/agent

The Ops Agent backend: a **Mastra server on Bun**. There is no separate backend framework. Agents,
workflows, memory, storage and tracing come from Mastra. We add Better Auth, a handful of typed custom
routes, and the Inngest serve endpoint.

## Why a server adapter instead of `mastra dev`

Mastra documents two ways to serve a project: the generated server (`mastra dev` / `mastra build`) or a
**server adapter**: "Run Mastra with Express, Hono, or your own HTTP server instead of the generated
server" ([Server overview](https://mastra.ai/docs/server/server-adapters), also in the installed docs at
`@mastra/core/dist/docs/references/docs-server-overview.md`). We use the adapter: our own entry
(`src/index.ts`) serves one Hono app with `Bun.serve`, and mounts Mastra on it with `@mastra/hono` →
`MastraServer`.

| Need | `mastra dev`/`build` | Server adapter (`@mastra/hono`) |
|---|---|---|
| Custom routes under `/api/*` (`/api/me`, `/api/proposals`, ...) | `registerApiRoute` refuses paths under the `apiPrefix` (`/api`). We would have to move Mastra's built-ins to e.g. `/_mastra` | Any path. Mastra keeps its default `/api/agents`, `/api/workflows`, ... |
| `/api/auth/*` (Better Auth) and `/api/inngest` | Same `/api` restriction | Mounted directly on the app, in the order we choose |
| Lean OpenAPI for *our* routes, consumed by Orval | Mastra's generated doc includes every built-in route (hundreds), and `registerApiRoute` `openapi` metadata is hand-written | `@hono/zod-openapi`: the zod schemas validate requests **and** generate `/api/openapi.json` with only our routes. `.meta({ id })` becomes `components/schemas/<id>` |
| CORS with credentials | `server.cors` | `hono/cors`, with full control over ordering |
| One Bun entry in dev and prod | `mastra build` produces a Node-oriented bundle | `bun --watch src/index.ts` / `bun src/index.ts`. Same code path everywhere |

What we give up: `mastra dev`'s bundled Studio and file-based agent discovery. Agents, workflows,
tools, MCP servers and scorers are registered in code in `src/mastra/index.ts`. With a server adapter,
`mastra.startWorkers()` must be called ourselves (done in `src/index.ts`). Studio is run standalone
instead (next section).

## Mastra Studio

`mastra studio` serves Studio as a standalone SPA that connects to an already running server
([Studio deployment](https://mastra.ai/docs/studio/deployment)).

```bash
bun run dev       # terminal 1: the server on http://localhost:4111
bun run studio    # terminal 2 (repo root or apps/agent): Studio on http://localhost:3000
```

Open http://localhost:3000, click **Sign in**, and use a seeded user (`operator@demo.dev` /
`demo-password`). How that works ([Studio auth](https://mastra.ai/docs/studio/auth)):

- Studio calls `GET /api/auth/capabilities`. Better Auth owns `/api/auth/*`, so `src/app.ts` lets the
  three Mastra auth paths Studio uses (`/api/auth/capabilities`, `/api/auth/me`,
  `/api/auth/credentials/sign-in`) fall through to `MastraServer`; Better Auth uses none of them.
- `BetterAuthMastraProvider` implements `getCurrentUser` and, **in development only**, Mastra's
  credentials interface: Studio's email/password form signs in through `auth.api.signInEmail`, which
  sets the normal `better-auth.session_token` cookie. Studio sends every request with
  `credentials: 'include'`, so all built-in routes authenticate exactly like the web app. Sign-up from
  Studio is always disabled.
- Alternative without the form: open `http://localhost:3000/?auth_header=Bearer%20<token>` with a
  bearer token (the `set-auth-token` header from `POST /api/auth/sign-in/email`). Studio keeps it in
  memory and sends it as `Authorization` on every request.
- CORS allows `STUDIO_ORIGIN` (default `http://localhost:3000`) **only when `NODE_ENV` is not
  `production`**. There is no auth bypass: the `x-mastra-dev-playground` header does nothing because
  our provider implements `authenticateToken` (checked: it still gets 401 without a session).
- In production the credentials sign-in is not wired (and Mastra's Studio sign-in screen with a custom
  provider needs an EE license there anyway); built-in routes still require a Better Auth session.

Expected noise in the browser console: a 404 on `/refresh-events` (that is `mastra dev`'s hot-reload
channel) and `/connect/providers` (optional platform feature).

## The harness in this app

`packages/harness` owns proposal → policy → decision → execution → audit. This app implements its
ports against Postgres (`src/harness/`):

| File | Port | Notes |
|---|---|---|
| `proposal-store.ts` | `ProposalStore` | `proposal` + `proposal_op` (+ `approval` for the decision) in one transaction. `compareAndSet` is `UPDATE proposal … WHERE id = $1 AND version = $2`; zero rows → `false`. Reads are parsed with the harness `ProposalSchema` (round-trip is exact, checked in tests) |
| `audit-sink.ts` | `AuditSink` | INSERT-only into `audit_event`; `seq` (bigserial) gives total order |
| `policy-rules.ts` | `PolicyRuleSource` | `policy_rule` rows → `{ key, params, enabled }`, read per evaluation |
| `harness.ts` | factory | `createAppHarness({ registry })`: Drizzle ports + system clock + inline steps. `inngestStepRunner(step)` adapts Inngest step tools for one durable step per op; inside a Mastra workflow step keep the inline runner (the Mastra step is the durable boundary, nested `step.run` isn't allowed) |
| `registry.ts` | `Registry<AppCtx>` | connectors `distru`, `headset`, `email`, `distru_mcp`; `AppConnectors` (async boot, degraded mode, refresh → rebuild); `appContexts()` (read ctx with client retries, execute ctx with `maxRetries: 0`); `appErrorClassifier` routed per connector |
| `policy.ts` | — | `appPolicyEngine` = harness built-ins + `emailRecipientDomainsRule`, used by the harness *and* `dryRunPolicy`; seed defaults (`DEFAULT_ALLOWED_ACTIONS`, `DEFAULT_EMAIL_DOMAINS`) |
| `app.ts` | singletons | `appHarness` (registry getter, `appErrorClassifier`, `appPolicyEngine`) and `appPolicyRules`, shared by routes and the restock workflow |
| `dry-run.ts` | — | `previewOp` / `dryRunPolicy`: what `harness.propose` would compute, without persisting (propose tools + review loop) |

### Connectors and boot (`src/harness/registry.ts`)

| id | system | role |
|---|---|---|
| `distru` | erp | REST: velocity, stock, vendors, compliance; `purchases.upsert`, `tasks.create` |
| `headset` | analytics | retail sell-through (read-only): `retail_trends`, `demand_signal`, … (`HEADSET_BASE_URL`, `HEADSET_API_TOKEN`) |
| `email` | email | `send_vendor_po` (high risk: always a human). Mock outbox by default; Resend when `RESEND_API_KEY` (+ `EMAIL_FROM`) is set |
| `distru_mcp` | erp | Distru's MCP through the bridge (`DISTRU_MCP_URL`, default `http://localhost:4500/mcp`; `DISTRU_MCP_KEY`, default `distru_mcp_mock`; empty URL disables it) |
| `composio` | other | Gmail / Calendar via Composio (`@ops/connector-composio`; the emulator by default: `COMPOSIO_BASE_URL=http://localhost:4700`, `COMPOSIO_API_KEY=ak_emulator_goldencoast_local0001`, `COMPOSIO_USER_ID=golden-coast`; empty key disables it, empty base URL = real Composio). Thread reads + `gmail_reply_to_thread` (high risk) for the vendor-reply loop |

**Composio degraded mode** works like `distru_mcp`: if Composio (the emulator) is down at boot the app
starts without it (`ctx.connectors.composio` is a placeholder that fails with a retryable "unavailable"
error), and `AppConnectors` retries every `min(DISTRU_MCP_REFRESH_MS, COMPOSIO_REFRESH_MS)` until it
connects, then rebuilds the registry. Errors route through `composioErrorClassifier`.

**Triggers** (`registry.triggers()`): `distru.order_created` (Distru connector), `composio.gmail.new_message`
(Composio connector), and the app-level `slack.interaction` + `schedule.morning_restock`
(`src/harness/triggers.ts`). Every webhook route goes through harness `ingestWebhook` (signature over
the raw body, zod-validated event, `trigger.received` / `trigger.rejected` in the audit trail).

`distru_mcp` is built from a live `tools/list`, so `src/index.ts` awaits `appConnectors.start()` before
serving. **Degraded mode**: if the MCP server is unreachable the app boots without it, logs why, and
`GET /api/connectors` lists `distru_mcp` with `health.ok: false` and the reason. A timer
(`DISTRU_MCP_REFRESH_MS`, default 60 s) retries; once connected each tick re-lists tools and rebuilds
the registry when tools were added, removed or reclassified. A connector that was registered once is
never dropped because the server is briefly down (pending proposals may reference its actions); its
health probe reports the outage instead. The harness reads the registry through a getter and the agents
resolve their tools per call (Mastra dynamic `tools`, memoized per registry instance), so a rebuilt
registry is live without a restart. Errors are classified by the failing op's connector
(`routeErrorClassifier`: Distru REST, MCP endpoint, Resend).

Default policy (seeded): `max_total_value` $25,000 (deny above), `auto_approve_below` `{ amount: 500, max_risk: 'medium' }`
(so small Distru POs, which are medium risk, auto-approve; high risk never does), `high_risk_requires_approval`,
`allowed_actions: [distru.purchases.upsert, distru_mcp.mutate_product, email.send_vendor_po, distru.tasks.create]`
(an unedited old `[distru.purchases.upsert]` row is upgraded by the seed), `email_recipient_domains` (enabled, deny
outside the six mock vendors' domains, e.g. `sierraextractsco.com`), and `vendor_allowlist` present but disabled.
Emails, tasks and buyer caps are `moneyless` (value 0), so `max_total_value` still applies to a cross-tool proposal.

## Vendor-reply loop (`src/mastra/workflows/vendor-reply.ts`)

Vendor replies to a PO email → Composio Gmail trigger → signed webhook → `POST /api/webhooks/composio`
(`ingestWebhook`, 401 when forged) → Inngest `composio/gmail.new_message` (id `composio.gmail.new_message:<webhook-id>`,
so a redelivery is a no-op) → function `vendor-reply-on-email` → Mastra workflow `vendor-reply` (Inngest):

1. **match** (code): sender address → Distru vendor (PO email, else same domain); `PO-\d+` in the subject/snippet
   → that vendor's PO (`listPurchases(purchase_numbers, company_ids)`; a number belonging to another vendor is
   never used; without one, only a single open PO is unambiguous). Non-vendor mail / unknown PO → `ignored`.
2. **read-thread**: `composio.gmail_fetch_message_by_thread_id` as the Liaison (untrusted text); falls back to
   the trigger's snippet while Composio is down.
3. **classify**: the **Vendor Liaison** agent (`agents/vendor-liaison.ts`; scopes read + propose, read tools only,
   budget 6 steps / $0.5, `VENDOR_LIAISON_MODEL`) returns `{ kind: partial|delay|confirm|price_change|other,
   lines[{ sku, product_id, shipped_quantity, backordered_quantity, new_unit_price }], eta, eta_text, summary,
   injection_detected, suspicious_text }`, copying numbers as stated and never acting on the email.
4. **plan** (code, `validateAgainstPo`): shipped must be an integer in `1..ordered-1`, prices within ±50% of the PO
   price, ETA within 180 days, lines must be on the PO; everything else becomes a finding, not a change. Ops:
   `distru.purchases.upsert` (only the validated quantity/price changes; other lines untouched) → buyer cap
   `distru_mcp.mutate_product` when (on hand + units shipping now) ÷ avg daily demand < days to the new ETA
   (`computeCap` / `activeBuyers` from the allocation guard; skipped when no demand, no buyers, or an existing
   cap is tighter) → acknowledgement `composio.gmail_reply_to_thread` (high risk; body from validated numbers
   only) → `distru.tasks.create` for the buyer (due at the ETA). A suspicious email gets **no** reply op and is
   flagged; a confirmation carrying an injection produces no proposal at all (Slack `#purchasing` is told).
5. **propose** (Vendor Liaison principal, `meta.workflowId: 'vendor-reply'`, analysis, changes, capChecks,
   findings) → **await-decision** (same step id as restock) → **execute** → **finalize**.

`resumeRunOnDecision` resumes whichever workflow created the proposal (`meta.workflowId`: `restock` or
`vendor-reply`; `RestockLauncher.resumeAfterDecision(runId, data, workflowId)`).

## Slack approvals (`src/slack/`, `src/api/webhooks-slack.ts`)

`SlackApprovals` (`@slack/web-api` WebClient; emulator by default: `SLACK_API_URL=http://localhost:4700/slack/api/`,
`SLACK_BOT_TOKEN=xoxb-emulator-goldencoast-ops-agent`; empty token disables Slack) is the workflows' `notifier`:

- A proposal entering `pending_approval` (restock or vendor-reply) is posted to `SLACK_APPROVALS_CHANNEL`
  (`#ops-approvals`) as Block Kit: title, total, op count, policy outcome, ops grouped by system
  (`ERP · distru`, `Other · composio`, high-risk marked), the non-pass policy reasons, a flag line for ignored
  untrusted text, and **Approve** / **Reject** / **Open proposal** (`WEB_BASE_URL` or the first `WEB_ORIGIN` +
  `/approvals/<id>`).
- `POST /api/webhooks/slack`: `ingestWebhook('slack.interaction')` checks `x-slack-signature` v0 over the raw body
  with a 300 s timestamp window (`SLACK_SIGNING_SECRET`; 401 otherwise), parses `block_actions`, maps the member to
  an Ops Agent user by email (`users.info` → `user` table: `olivia`/operator@demo.dev, `adam`/approver@demo.dev) and
  calls the same `proposals.decide` as the UI (`harness.decide` with that user's principal, then the resume hook).
  An operator gets an ephemeral "Only approvers can decide" (the harness's scope check refuses), a second click an
  ephemeral "Already decided: approved by …", an unlinked member an ephemeral too. On success the message is
  `chat.update`d (buttons replaced by "Approved by Adam Approver … via Slack"). Events API deliveries to the same
  URL are verified and acknowledged (URL-verification challenge answered).
- Run notifications to `SLACK_NOTIFY_CHANNEL` (`#purchasing`): proposal created / auto-approved / denied,
  executed (verified or not), failed (which op), rejected, and flagged vendor emails.
- Best-effort: every Slack failure is logged and swallowed, never failing a workflow step.

## Agents and the restock workflow

- Agents (`src/mastra/agents/`): Ops Lead (supervisor via Mastra `agents` subagents, Memory, read-only +
  `start_restock_run`; answers AR questions from `distru_invoices_overdue` / `distru_invoices_search`), Inventory Analyst, Procurement Planner (only one with `propose_*`), Compliance Reviewer,
  Policy Critic, and the Vendor Liaison (vendor-reply loop only). Scopes, tool allowlists and budgets in `roster.ts`; models per agent from env (`*_MODEL`, default
  `OPS_AGENT_MODEL`). Tools are generated from `registry.catalog(principal)` (`src/mastra/tools/harness-tools.ts`).
- `propose_*` tools never write: inside a workflow run they add an op to the run's draft (same vendor + location
  replaces), outside one they call `harness.propose` (pending proposal).
- `src/mastra/workflows/restock.ts` (Inngest): prepare → foreach location Analyst → group by vendor (+ allocation
  guard, in code) → foreach vendor Planner → review loop (Compliance veto + deterministic `compliance_check`, plan
  guard, policy dry-run, deny → Critic → Planner revision with per-vendor budgets; max 2 revisions) → one
  cross-tool proposal → suspend unless auto-approved → execute → finalize.

### Cross-tool restock

- **Inventory Analyst** blends wholesale velocity (Distru) with retail sell-through (Headset `retail_trends`,
  `demand_signal`; the maths is in `demand_signal`, not the prompt). SKUs that retail flags `reorder_now`/`watch`
  are included even when Distru says OK (`flagged_by: retail`), and every reason cites both sources.
- **Allocation guard** (`src/mastra/workflows/cross-tool.ts`, code only): a SKU whose retail-adjusted days of supply
  (recomputed with `headset.demand_signal`) are below its vendor's lead time will stock out before the PO arrives.
  Cap = company-wide available ÷ distinct buyers with orders in the last 14 days, rounded down to whole cases, at
  least one case; skipped when nobody ordered it or an existing cap is already tighter. The Planner gets the caps as
  suggestions and proposes `distru_mcp.mutate_product` `{ action: UPDATE, id, maxMenuBuyerOrderQuantity }`; the plan
  guard denies any other value/field, and a suggestion the Planner omitted is backfilled by the workflow
  (`meta.crossTool[].source: guard-backfill`). Caps whose SKU ends up on no PO are dropped. `before` comes from
  `get-product`, so the diff is `null → 25` and an undo can restore it. No caps (with a rationale note) while
  `distru_mcp` is down.
- **Assembly** (per PO, in this order): PO → its buyer cap(s) → `email.send_vendor_po` to the vendor's PO address →
  `distru.tasks.create` "Receive {{op:N.purchase_number}} on <date>" (due = today + lead time, owner resolved from
  `RESTOCK_TASK_OWNER_ROLE` via `GET /users`, linked with `purchase_id: {{op:N.recordId}}`). The email and the task
  use **harness op references** (packages/harness README, "Op references"): the diff shows the placeholder, the
  executor resolves it from the PO op's result and records the value in `op.result.resolved`. Because the email is
  high risk, a proposal with POs always needs a human. `RestockDeps.crossTool` can switch each part off.
- `RestockResult` adds `emailIds`, `taskIds`, `buyerCapProductIds`; a failure names the failed op and stays
  resumable (earlier ops are skipped on resume). Proposal meta carries `atRisk` (why each SKU is in), `allocationGuard`
  (with status) and `crossTool` (op → PO, source). Cron (`RESTOCK_CRON_ENABLED=1`) and webhook triggers are Inngest
  functions in `src/mastra/functions.ts`.
- `bun run restock:demo [-- --location "Oakland"]`: live demo through the API (needs ANTHROPIC_API_KEY, the
  Distru mock on :4500 (REST + MCP), the Headset mock on :4600 (`bun run dev:headset`), the server and
  `bun run inngest:dev`). Prints ops per system, retail-driven picks, guard caps, emails, tasks and cost.

## MCP server (`/mcp`): the harness for Claude Code / Codex

`src/mastra/mcp/ops-mcp.ts` (tools) + `src/api/mcp-http.ts` (route) + `src/services/mcp-tokens.ts`.

- **Auth**: an approver creates a token in Settings or with `POST /api/mcp-tokens { name, scopes }`
  (`scopes` ⊆ `read | propose | approve`, `read` implied). The response holds the plaintext
  `ops_mcp_…` once; only its SHA-256 is stored (`mcp_token`). Each request maps to
  `mcpClientPrincipal(tokenId, scopes)`; `DELETE /api/mcp-tokens/:id` revokes it on the next request.
  Sessions are not accepted on /mcp. Token create/revoke are audited.
- **Tools are the principal's**: one @mastra/mcp `MCPServer` per scope set, generated from
  `registry.catalog(principal)`, so a read-only token never sees a `propose_*` tool; the harness
  re-checks every scope anyway. Separation of duties: a token can't decide what it proposed.
- **Distru conventions**: every tool takes `intent` (audited as `mcp.tool_called` with the token id,
  and forwarded to Distru's MCP as its `intent` on bridged reads); `get_me` first; lists page with
  `limit` + `cursor` → `{ items, hasMore, nextCursor }`.
- **Tools**: `get_me`; every registry read tool (`distru_*`, `headset_*`, `distru_mcp_*`, …); with
  `propose`: every `propose_*` (calls `harness.propose`, returns proposal id, op summaries + diff,
  policy outcome; never writes), `propose_undo`, `start_restock_run`; `list_proposals`, `get_proposal`
  (full ops + diff + undo info), `list_audit_events`, `get_run`; with `approve`: `decide_proposal`.
- Approved proposals that no workflow waits on (MCP, undo) are executed by the Inngest function
  `proposal-execute` (`ops/proposal.execute`, one durable step per op); auto-approved MCP proposals too.
- `bun run mcp:smoke`: signs in as the approver, creates a throwaway token, lists tools, calls
  `get_me`, a read tool and `propose_distru_purchases_upsert` with the MCP SDK client, then revokes it.

Claude Code (`.mcp.json` in the repo root, or `claude mcp add --transport http ops-agent http://localhost:4111/mcp --header "Authorization: Bearer $OPS_MCP_TOKEN"`):

```json
{
  "mcpServers": {
    "ops-agent": {
      "type": "http",
      "url": "http://localhost:4111/mcp",
      "headers": { "Authorization": "Bearer ${OPS_MCP_TOKEN}" }
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.ops-agent]
url = "http://localhost:4111/mcp"
bearer_token_env_var = "OPS_MCP_TOKEN"
```

The server speaks MCP 2026-07-28 and serves 2025-era clients (that open with `initialize`) statelessly.

## Execution reliability (`src/mastra/proposal-executor.ts`, `src/services/pending-executions.ts`)

- Approved / auto-approved proposals that no workflow run will execute (Copilot propose tools, MCP, undo,
  a run that already finished) go to `proposal-execute` (`ops/proposal.approved`, event id
  `proposal-approved-<id>`, concurrency 1 per proposal, one durable step per op).
- If Inngest is unreachable when a decision / auto-approval / resume is recorded, a **pending-execution
  marker** (`pending_execution`) is written; the decision is never lost.
- The **execution sweeper** (Inngest cron `proposal-execution-sweeper`, every minute, plus once at boot)
  retries markers and re-enqueues approved / auto-approved proposals whose execution never started (2-minute
  grace; time-bucketed event ids at most every 10 minutes). Run-linked proposals follow the decision logic:
  a suspended run is resumed, a running one left alone, a finished one handed to `proposal-execute`.
  Idempotent: the executor skips executed ops and dedupes every write by its key.
- **Resume**: `POST /api/proposals/:id/resume` (approver) records `proposal.resume_requested` and queues the
  same executor (`resume: true`); only `failed` proposals (undo proposals included) resume, and only what is
  left re-runs. `ProposalDetail.resumable` drives the button.

## Context layer (`src/context/`, `@ops/context`)

- Store: `DrizzleContextStore` (Postgres schema `context`, in `drizzle.config.ts` → `db:push`).
- Sync: `createDistruSync` with an observer-wrapped Distru client; Inngest cron `context-sync`
  (`CONTEXT_SYNC_CRON`, default every 30 min; empty disables): `sync.run()` → `buildProfile()` → learning
  from any decided proposal not learned yet. Distru PRODUCT / PURCHASE / ORDER / COMPANY webhooks →
  `distru/record.changed` → `context-record-sync` (`sync.handleWebhook`, deduped on type, id, occurred_datetime).
  `bun run context:sync` runs one pass by hand and prints the profile and memories (`-- --reconcile` forces
  a full re-read, e.g. after the mock was reseeded). `bun run db:seed:history` (`db:seed:history:reset` to
  recreate) adds ~12 backdated decided proposals and a cap revision, so the next pass learns 5 memories.
- Memories: after every decision `ingestHarnessEvents(signalsFromAudit(...))` (approver edits are compared
  with `meta.originalOps`, which the harness keeps on edited approvals); `policy.changed` →
  `policy_rule_changed` signals, both live (learning audit sink) and in the batch pass (`learnFromHistory`).
- Agents: the `context` connector is registered; the Planner and the Vendor Liaison get
  `context_context_for` and a bounded (~1,600 chars) ACCOUNT CONTEXT block in their prompts; the Ops Lead
  gets `context_vendor_profile` and `context_memories_search` for Copilot questions.
- API: `GET /api/context/profile`, `GET /api/context/memories`, `GET /api/onboarding`.

## Semantic recall (`src/context/recall.ts`, `@ops/context` `recall`)

Retrieval over unstructured text, next to the relational context layer (which never stores free text):

- **Embedder**: FastEmbed `bge-small-en-v1.5` (`@mastra/fastembed`, local ONNX, 384 dims): no API key, no
  per-call cost, offline after a one-time ~30 MB model download to `~/.cache/mastra` on the first embed (the
  module is imported lazily). `RECALL_EMBEDDER=hash` swaps in the lexical `HashEmbedder` (no download).
- **Vectors**: `PgVector` (`@mastra/pg`), schema `recall`, index `recall_chunks_384` (HNSW, cosine, btree on
  `docId` / `vendorId`). Not in `context`: drizzle-kit owns that schema and would drop unknown tables.
  **Ledger + cursors**: `context.recall_documents` (one row per source document: content hash, chunk count,
  embedder; unchanged documents are never re-embedded) and `context.recall_cursors`.
- **Sources**: the purchasing mailbox through Composio Gmail (`GMAIL_FETCH_EMAILS`, `after:` cursor with a
  10-minute overlap, paged by narrowing `before:`); a vendor reply as it arrives (Inngest
  `recall-index-on-email` on the same `composio/gmail.new_message` event as the vendor-reply loop, reads the
  message by id); Distru PO descriptions / notes handed over by the context sync (`onFreeText`, boilerplate like
  "Restock from <vendor>" is skipped). Inngest cron `recall-index` (`RECALL_INDEX_CRON`, default every 15 min)
  runs the incremental mailbox pass. `bun run recall:index` runs one pass by hand (`-- --reindex` forgets
  everything, reconciles the Distru sync and re-embeds it all) and prints a probe search.
- **Tool**: the `recall` connector (registered unless `RECALL_ENABLED=0`): `recall.search` → `recall_search`
  for the Ops Lead, Procurement Planner and Vendor Liaison (`AGENT_TOOLS`); their instructions get the recall
  section only when it is registered (`withRecall`).
- **Copilot memory**: the Ops Lead's `Memory` uses Mastra `semanticRecall` (`topK 3`, `messageRange 1`,
  `scope: 'resource'`) on PgVector (schema `mastra`) with the same FastEmbed model, so earlier Copilot turns
  of the same operator are recalled across threads.
- **API**: `GET /api/recall/search?q=&vendorId=&since=&source=&limit≤8` (operator / approver) → passages
  with `ref`, date, vendor, PO numbers, score; text wrapped as untrusted, `suspicious` flagged; 503 when
  disabled. The Copilot page has a small "Search history" box on top of it.

## Restock quality and cost

- **Deterministic demand scan** (`src/mastra/workflows/demand.ts`): Distru velocity per location and vendor
  lead-time group (wholesale: LATE / ORDER_NOW / ORDER_SOON or days of supply < lead time) plus Headset
  retail movers (surging / rising / stock-outs rising), with `headset.demand_signal` computed in code for
  every mover and wholesale candidate at the run's locations.
- **Pre-check**: when the scan finds nothing at risk in scope, `prepare` returns no locations and the run
  ends `nothing_to_order` with zero LLM calls.
- **Merge**: code-flagged SKUs the Analyst missed are added (e.g. PRE-BD-1G), and `flagged_by` (wholesale /
  retail / both) is computed from the numbers, never taken from the model.
- **Buyer cap**: a company-wide setting, so its trigger uses company-wide days of supply (velocity report
  without a location filter, blended with retail) and its share uses company-wide available stock.
- **Prompt caching**: every agent's instructions are a system message with an Anthropic cache breakpoint
  (caches the tool definitions too, rendered before the system prompt), and agent calls request automatic
  caching (a moving breakpoint over the loop). Run totals record `cacheRead` / `cacheWrite`; cost prices
  them at 0.1× / 1.25× input.
- **Headlines**: proposals have a short `title` (≤ 60) and a `summary`. The Planner (single-vendor runs)
  and the Vendor Liaison write them; `src/harness/titles.ts` checks shape, URLs/markdown, instruction-like
  phrases, every number / amount / date / PO number against the proposal, vendor names, and 8-word overlap
  with untrusted text; otherwise a template is used. `meta.titleSource` (`agent` | `template` | `caller`) and
  `meta.titleRejectedReason` are stored and audited on `proposal.created`. MCP propose tools take optional
  `title` / `summary` (rejected, never rewritten). `bun run titles:backfill` shortened old long titles.

## Other

- Slack approval posts are idempotent per proposal (`slack_message` stores the ts; a retried step updates).
- Sent vendor emails persist in `email_sent` (mock outbox and Resend), so dedupe survives restarts.
- Policy rules removed with `PUT /api/policy-rules` are soft-deleted (`deleted_at`), so `db:seed` never
  resurrects them.
- The A2A agent card publishes the agent's short `description`, never its instructions (`src/api/a2a-card.ts`).
- Tests never touch the dev database: `test/preload.ts` points `DATABASE_URL` at `TEST_DATABASE_URL`
  (default `ops_test` on the same server), creates it and builds the schema from the Drizzle files
  (rebuilt when they change).

## Undo

`POST /api/proposals/:id/undo` (or MCP `propose_undo`) → `harness.undo` (packages/harness README,
"Undo / rollback"): a new proposal of compensating ops in reverse order that needs an approver.
Compensations: Distru PO created → `DELETE /purchases/{id}` while never received (Distru has no
cancelled status), PO updated → restore the previous lines/notes, Distru task → delete, Distru MCP
`mutate_product` (buyer cap) → `UPDATE` back to the `before` value. Vendor emails are listed as not
undoable. Window: `UNDO_WINDOW_HOURS` (default 168). The proposal detail's `undo` block drives the UI.

## A2A

Mastra's built-in A2A routes expose every registered agent; the Ops Lead is
`GET /api/.well-known/ops-lead/agent-card.json` (discovery) and `POST /api/a2a/ops-lead` (JSON-RPC:
`message/send`, `message/stream`, `tasks/get`, …; `A2A-Version: 1.0` for v1). `MastraServer` gets an
`InMemoryTaskStore` (required for execution; paused tasks resume only on the same process). Auth: a
Better Auth session, or an MCP token (card: any valid token; execution: `propose`, because the Ops Lead
can start a restock run); the token is accepted on these two routes only.

```bash
curl -H "Authorization: Bearer $OPS_MCP_TOKEN" http://localhost:4111/api/.well-known/ops-lead/agent-card.json
curl -X POST http://localhost:4111/api/a2a/ops-lead -H "Authorization: Bearer $OPS_MCP_TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"kind":"message","role":"user","messageId":"m1","parts":[{"kind":"text","text":"Which SKUs are at risk in Oakland?"}]}}}'
```

From another Mastra app: `new A2AAgent({ url: '<host>/api/.well-known/ops-lead/agent-card.json', headers: { Authorization: 'Bearer …' } })`.

## Layout

```
apps/agent/
├── src/
│   ├── index.ts              Bun.serve entry: createApp(), startWorkers(), graceful shutdown
│   ├── app.ts                Hono app: CORS → /api/auth/* → /api/inngest → custom routes → MastraServer
│   ├── env.ts                zod-validated env (exits on invalid config; prod guards for Inngest)
│   ├── api/
│   │   ├── schemas.ts        zod 4 boundary schemas, each with .meta({ id }) for stable OpenAPI names
│   │   ├── routes.ts         OpenAPIHono routes + /api/openapi.json
│   │   ├── ops-routes.ts     MCP tokens, undo, policy rules, locations (schemas in schemas-ops.ts)
│   │   ├── mcp-http.ts       /mcp: token → principal → MCPServer.startHTTP
│   │   └── services.ts       ApiServices interface (injected, so routes are testable without a DB)
│   ├── auth/
│   │   ├── auth.ts           Better Auth 1.7.7 (email+password, `role` additionalField, bearer plugin)
│   │   ├── session.ts        session resolver, sessionMiddleware, requireUser, requireRole(...)
│   │   ├── mastra-auth.ts    MastraAuthProvider that reuses the Better Auth session for built-ins
│   │   └── a2a-tokens.ts     MCP tokens accepted on the two A2A routes
│   ├── db/
│   │   ├── schema.ts         Drizzle: Better Auth tables + proposal (versioned), proposal_op, approval,
│   │   │                     audit_event (+ request_id), policy_rule (harness rule configs), eval_run, mcp_token
│   │   ├── client.ts         drizzle(postgres-js)
│   │   └── seed.ts           demo users + default policy rules (idempotent)
│   ├── harness/              @ops/harness ports on Drizzle + createAppHarness (see "The harness in this app")
│   ├── services/proposals.ts list/get read Postgres; decide calls harness.decide; audit list
│   └── mastra/               layout per https://mastra.ai/reference/project-structure
│       ├── index.ts          central registration: agents, workflows, tools, mcpServers, scorers,
│       │                     PostgresStore (schema `mastra`), tracing, auth
│       ├── inngest.ts        Inngest client + init() → Inngest-backed createWorkflow/createStep
│       ├── agents/ops-agent.ts  placeholder supervisor agent (model router string)
│       ├── workflows/hello.ts   2-step workflow with one suspend/resume point
│       ├── tools/            harness-generated tools (propose_* / read tools) — empty for now
│       ├── mcp/ops-mcp.ts    our MCP server: MCPServer per token scope set (served at /mcp by src/api/mcp-http.ts)
│       └── scorers/          eval scorers — empty for now
├── scripts/verify-hello-workflow.ts   e2e: sign in → start → suspended → resume → success
├── test/                     bun tests: role guard, decision route (auth + harness error mapping),
│                             OpenAPI shape, harness-postgres integration (skips without Postgres)
└── drizzle.config.ts         manages the `public` schema only
```

## Routes

| Path | Auth | Notes |
|---|---|---|
| `GET /api/health` | public | includes a DB ping |
| `GET /api/me` | session | `{ id, email, name, role }` |
| `GET /api/proposals?status=&limit=&offset=` | session | summaries: status, version, policy outcome, total, actions, `maxRisk`, `opSummaries[]` (summary, risk, status, value, `connector {id, system}`, `reaches` from the MCP bridge classification), `undoOf` |
| `GET /api/proposals/:id` | session | harness shape: ops with diff/payload/before/result, policy evaluation with reasons, status, version, decision, execution, plus `undo: { available, reason, ops: [{ opIndex, canUndo, reason, undoProposalId }], undoProposalId, undoOf, until }` |
| `POST /api/proposals/:id/undo` | operator/approver | `{ reason, opIndexes? }` → `harness.undo` → 201 `{ proposal }` = a NEW pending undo proposal (needs an approver; never auto-approved). 409 `undo_unavailable` (+ `undo` info), 400 when a record moved on (e.g. PO received) |
| `POST /api/proposals/:id/decision` | **approver** | `{ decision: 'approve'\|'reject', reason?, edits? }` → `harness.decide` with `userPrincipal(user.id, role)`. Errors: 400 `InputValidationError`, 403 `ForbiddenError` (scope, separation of duties), 404 `NotFoundError`, 409 `decision_conflict` / `concurrent_modification` / `policy_denied` (+ `evaluation`). After the decision, the suspended restock run (`meta.workflowRunId`) is resumed (idempotent no-op unless suspended) |
| `GET /api/audit-events?proposalId=&type=&order=&limit=&offset=` | session | newest first by default; `order=asc` for a timeline. Each event has `requestId` (the `x-request-id` of the API/MCP call that caused it) and, for op events, the op's `idempotencyKey` and `diff` |
| `GET /api/runs?limit=` | session | restock runs from Mastra run storage, each with its linked proposal and `totals` (tokens, cost, agent/tool calls) |
| `GET /api/runs/:id` | session | status, input/result, step timeline with agent calls (tokens, cost estimate, tool calls with trimmed `args` / `result`; untrusted text stays wrapped), suspend payload, linked proposal |
| `POST /api/runs` | operator/approver | `{ scenarioNote?, locationIds?, vendorIds?, productIds? }` → 202 `{ runId }` (503 if Inngest is down) |
| `GET /api/connectors` | session | connector health + tool catalogue |
| `POST /api/proposals/:id/resume` | **approver** | resume a failed proposal through `proposal-execute` → 202 `{ proposal, queued }`; 409 `not_resumable` |
| `GET /api/evals` · `GET /api/evals/:scenario/history` | session | latest `eval_run` row per scenario · one scenario over time |
| `GET /api/context/profile` · `GET /api/context/memories` · `GET /api/onboarding` | session | account profile, learned memories, onboarding report |
| `GET /api/recall/search?q=&vendorId=&since=&source=&limit=` | operator/approver | semantic recall over vendor email, vendor replies, PO notes: passages (`ref`, date, vendor, PO numbers, score, untrusted-wrapped subject/from/text, `suspicious`) + `embedder`, `documents`; 503 when `RECALL_ENABLED=0` |
| `GET /api/locations` | session | own Distru locations (ids for `POST /api/runs`), cached 5 min |
| `GET /api/policy-rules` · `PUT /api/policy-rules` | session · **approver** | rules + rule types (params JSON Schema); PUT replaces the set, validated against the engine's rules (400 `invalid_policy` + issues), audited `policy.changed` |
| `POST /api/mcp-tokens` · `GET` · `DELETE /api/mcp-tokens/:id` | **approver** | per-client MCP tokens (see "MCP server"): create returns the token once |
| `/mcp` | MCP token (`Bearer ops_mcp_…`) | our MCP server (Streamable HTTP). Not in OpenAPI |
| `GET /api/.well-known/ops-lead/agent-card.json`, `POST /api/a2a/ops-lead` | session or MCP token | Mastra built-in A2A (see "A2A") |
| `POST /api/webhooks/distru` | HMAC (`x-distru-signature`, `DISTRU_WEBHOOK_SECRET`) | trigger `distru.order_created` (`ingestWebhook`, audited); ORDER CREATE → Inngest `distru/order.created` (event id `distru.order_created:<type>:<id>:<occurred_datetime>`, so redeliveries dedupe) → `restock-on-distru-order`; PRODUCT / PURCHASE / ORDER / COMPANY → `distru/record.changed` → context sync |
| `POST /api/webhooks/composio` | Standard Webhooks signature (`COMPOSIO_WEBHOOK_SECRET`) | trigger `composio.gmail.new_message` → Inngest `composio/gmail.new_message` (deduped by webhook id) → vendor-reply run. Not in OpenAPI (provider-shaped body) |
| `POST /api/webhooks/slack` | `x-slack-signature` v0 (`SLACK_SIGNING_SECRET`, 300 s window) | trigger `slack.interaction`: Approve / Reject buttons → `harness.decide` as the mapped user. Not in OpenAPI |
| `GET /api/openapi.json` | public | OpenAPI 3.1 for the routes above (Orval input) |
| `/api/auth/*` | Better Auth | `sign-in/email`, `sign-up/email` (sign-up is disabled in production), `get-session`, ... |
| `/api/inngest` | Inngest signing | serves Mastra workflows as Inngest functions |
| `/api/agents`, `/api/workflows`, `/api/memory`, ... | session | Mastra built-ins, protected by `BetterAuthMastraProvider` |

### How auth works

- Better Auth sets the `better-auth.session_token` cookie (HttpOnly, SameSite=Lax). Non-browser clients
  can send `Authorization: Bearer <token>` instead (`bearer()` plugin; the token comes back in the
  `set-auth-token` header on sign-in).
- **Custom routes:** `sessionMiddleware(resolver)` runs only on our paths and sets `c.var.user`
  (`SessionUser | null`, never throws). Each route declares `requireUser` or `requireRole('approver')`
  in its `createRoute({ middleware })`. Role checks run **before** body validation, so an operator always
  gets 403 and never a validation error.
- **Mastra built-ins:** `BetterAuthMastraProvider.authenticateToken()` resolves the same session from the
  request headers. Mastra's defaults apply: `/api/*` is protected and `/api/auth/*` is public.
  `mapUserToResourceId` ties memory threads and workflow runs to the user id.
- `role` is `input: false`. Clients can't set it on sign-up (checked: a sign-up body with `role: 'approver'`
  still creates an operator). Roles change only server-side (the seed script).

## Running locally

```bash
# from the repo root
docker compose up -d                       # postgres 16 + pgvector on 127.0.0.1:5482
bun install
cp apps/agent/.env.example apps/agent/.env # then set BETTER_AUTH_SECRET (openssl rand -base64 32)

cd apps/agent
bun run db:push                            # pgvector extension, then drizzle-kit push (public + context; see Known issues)
bun run db:seed                            # operator@demo.dev / approver@demo.dev, password demo-password
bun run db:seed:history                    # optional: decision history → memories on the next context:sync
bun run recall:index                       # optional: index the mailbox (needs dev:emulators) + PO notes for recall
bun run dev                                # http://localhost:4111

# second terminal: Inngest dev server (UI on http://localhost:8288)
bun run inngest:dev                        # (apps/agent) uses npx, see "Known issues"
bun run verify:hello                       # suspend → resume through Inngest
bun test                                   # Postgres tests use TEST_DATABASE_URL (default ops_test), never the dev DB
bun run studio                             # Mastra Studio on :3000 (see "Mastra Studio")
```

Mastra creates its own tables in the `mastra` schema on first boot (`PostgresStore({ schemaName: 'mastra' })`).
Traces go to `mastra.mastra_ai_spans` through `MastraStorageExporter`.

## Production

`bun run start` (`NODE_ENV=production bun src/index.ts`). At boot the env check requires
`INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` and refuses to start if `INNGEST_DEV` is set. Email sign-up
is disabled. Point Inngest Cloud at `https://<host>/api/inngest`. Run behind a proxy that sets
`X-Forwarded-For`, because Better Auth's rate limiter reads the client IP from it.

## Known issues

- `drizzle-kit push` asks interactively when a change looks like a column rename. The harness schema
  change was applied by dropping the (empty) domain tables first:
  `DROP TABLE approval, proposal_op, proposal, audit_event, policy_rule CASCADE;` then `db:push` + `db:seed`.

- `bunx inngest-cli@latest` fails because bun skips the package's postinstall, which downloads the binary.
  The root `inngest:dev` script uses `bunx`, so for now use `bun run --cwd apps/agent inngest:dev` (npx
  with scripts enabled).
- `@mastra/evals` declares `vitest` as a peer. Our tests use `bun test`, so the peer stays unmet until
  scorers are run through vitest (if ever).
