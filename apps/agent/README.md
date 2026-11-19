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

## Agents and the restock workflow

- Agents (`src/mastra/agents/`): Ops Lead (supervisor via Mastra `agents` subagents, Memory, read-only +
  `start_restock_run`), Inventory Analyst, Procurement Planner (only one with `propose_*`), Compliance Reviewer,
  Policy Critic. Scopes, tool allowlists and budgets in `roster.ts`; models per agent from env (`*_MODEL`, default
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
│   │   └── services.ts       ApiServices interface (injected, so routes are testable without a DB)
│   ├── auth/
│   │   ├── auth.ts           Better Auth 1.7.7 (email+password, `role` additionalField, bearer plugin)
│   │   ├── session.ts        session resolver, sessionMiddleware, requireUser, requireRole(...)
│   │   └── mastra-auth.ts    MastraAuthProvider that reuses the Better Auth session for built-ins
│   ├── db/
│   │   ├── schema.ts         Drizzle: Better Auth tables + proposal (versioned), proposal_op, approval,
│   │   │                     audit_event, policy_rule (harness rule configs), eval_run
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
│       ├── mcp/              our MCP server (read/propose/approve scopes) — empty for now
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
| `GET /api/proposals?status=&limit=` | session | summaries (status, version, policy outcome, total, actions) |
| `GET /api/proposals/:id` | session | harness shape: ops with diff/payload/before/result, policy evaluation with reasons, status, version, decision, execution |
| `POST /api/proposals/:id/decision` | **approver** | `{ decision: 'approve'\|'reject', reason?, edits? }` → `harness.decide` with `userPrincipal(user.id, role)`. Errors: 400 `InputValidationError`, 403 `ForbiddenError` (scope, separation of duties), 404 `NotFoundError`, 409 `decision_conflict` / `concurrent_modification` / `policy_denied` (+ `evaluation`). After the decision, the suspended restock run (`meta.workflowRunId`) is resumed (idempotent no-op unless suspended) |
| `GET /api/audit-events?proposalId=&type=&order=&limit=` | session | newest first by default; `order=asc` for a timeline |
| `GET /api/runs?limit=` | session | restock runs from Mastra run storage, each with its linked proposal |
| `GET /api/runs/:id` | session | status, input/result, step timeline with agent calls (tokens, cost estimate, tool calls), suspend payload, linked proposal |
| `POST /api/runs` | operator/approver | `{ scenarioNote?, locationIds?, vendorIds?, productIds? }` → 202 `{ runId }` (503 if Inngest is down) |
| `GET /api/connectors` | session | connector health + tool catalogue |
| `POST /api/webhooks/distru` | HMAC (`x-distru-signature`, `DISTRU_WEBHOOK_SECRET`) | ORDER CREATE → Inngest `ops/restock.requested` → restock run scoped to the ordered products |
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
docker compose up -d                       # postgres on 127.0.0.1:5482
bun install
cp apps/agent/.env.example apps/agent/.env # then set BETTER_AUTH_SECRET (openssl rand -base64 32)

cd apps/agent
bun run db:push                            # drizzle-kit push (public schema; see Known issues for renames)
bun run db:seed                            # operator@demo.dev / approver@demo.dev, password demo-password
bun run dev                                # http://localhost:4111

# second terminal: Inngest dev server (UI on http://localhost:8288)
bun run inngest:dev                        # (apps/agent) uses npx, see "Known issues"
bun run verify:hello                       # suspend → resume through Inngest
bun test                                   # incl. Postgres integration test (skips if DB is down)
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
