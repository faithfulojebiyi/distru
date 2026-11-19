# Ops Agent — a governed multi-agent harness for a cannabis ERP

Agents that **propose** changes across a business's core tools — ERP, commerce menus, email, analytics,
Gmail, Slack — and a harness that makes those writes **safe**: field-level diffs, deterministic policy,
human approval, idempotent durable execution, read-after-write verification, undo, and an append-only audit
trail. Usable from its own dashboard, from Slack, and from Claude Code / Codex over MCP.

Built against [Distru](https://www.distru.com)'s public REST API and MCP documentation as a portfolio
project. **Not affiliated with Distru.** Distru, Headset, Composio, Gmail and Slack are emulated locally
from their public docs; pointing at the real services is configuration (see [Real services](#real-services)).

> **LLMs propose, code executes.** No agent can write. Agents get read tools and `propose_*` tools generated
> from the harness registry; every write is a proposal that passes policy, waits for a person with the
> `approve` scope, and is executed by deterministic code.

---

## Why

Distru's MCP exposes 114 tools to AI assistants, 38 of them writes — some reaching Metrc, QuickBooks,
LeafLink, POS systems and email. Its safety model is the assistant's per-tool "Allow" dialog: there is no
dry-run, policy, idempotency, verification, undo or cross-step audit
([research notes](packages/connector-mcp/README.md)). That's fine for one-off questions; it isn't enough for
agents that run on a schedule, react to webhooks, and change several systems at once.

This project is the missing layer: **a harness that governs agent writes across systems** — including
Distru's own MCP.

## What it does (end to end)

**Restock** — every morning (Inngest cron), on a Distru webhook, or from the Copilot:

1. **Inventory Analysts** (one per location, in parallel) read Distru's inventory-velocity report and blend
   it with **Headset retail sell-through** in code (`demand_signal`), so a SKU Distru calls "fine" but that is
   surging at retail gets flagged.
2. **Procurement Planners** (one per vendor, in parallel) draft purchase orders.
3. A review loop: the **Compliance Reviewer** vetoes lines with failed lab tests / on-hold Metrc packages; a
   code **plan guard** rejects anything outside the analysed basis (the prompt-injection backstop); a policy
   dry-run; on deny, the **Policy Critic** explains and the Planner revises (≤ 2 rounds).
4. **One proposal** across systems, e.g. 14 ops: 4 POs (ERP), 2 per-buyer menu caps when stock runs out
   before delivery (Commerce, via Distru's MCP), 4 vendor emails citing the real PO number, 4 receiving
   tasks for a human in Distru.
5. Policy evaluates it; the run **suspends durably** until a person approves — in the dashboard or with the
   buttons in **Slack** (`#ops-approvals`).
6. The **executor** applies each op as its own durable step: idempotency key → write → **read back and
   verify** → audit. Re-running writes nothing. A failure mid-way leaves earlier ops done and the proposal
   resumable.

**Vendor reply** — a vendor answers the PO email ("we can only ship 200 of 312, rest ETA Dec 2") → Composio
Gmail trigger → signed webhook → the **Vendor Liaison** reads it as untrusted text → code validates every
number against the PO → one proposal: PO update (312→200), buyer-cap adjustment, in-thread reply, task.
Injection replies are flagged and change nothing.

**Undo** — any executed proposal can be reversed through a *new* compensating proposal (reverse order,
always needs approval). Ops that can't be undone (a sent email) are listed with the reason.

## Architecture

```
                    ┌──────────────────────── apps/web (TanStack Start) ────────────────────────┐
                    │ Overview · Copilot · Approvals (diffs, policy, decide) · Runs (agent trace)│
                    │ Audit log · Evals · Settings (connectors, policy rules, MCP tokens)        │
                    └───────────────────────────────┬────────────────────────────────────────────┘
 Claude Code / Codex ── MCP (/mcp, scoped tokens) ──┤
 Other agents ───────── A2A (/api/a2a/ops-lead) ────┤
 Slack buttons ──────── /api/webhooks/slack ────────┤
                    ┌───────────────────────────────▼──────── apps/agent (Mastra on bun) ─────────────┐
                    │  Agents: Ops Lead (supervisor) · Inventory Analyst · Procurement Planner ·       │
                    │          Compliance Reviewer · Policy Critic · Vendor Liaison                    │
                    │  Workflows on Inngest: restock · vendor-reply · proposal-execute                 │
                    │  Triggers: Distru webhooks · Composio Gmail · Slack interactions · cron          │
                    │  Better Auth (operator / approver) · Drizzle/Postgres · OpenAPI                  │
                    └───────────────┬───────────────────────────────────────────┬──────────────────────┘
                                    │                                           │
                 ┌──────────────────▼───────── packages/harness ─────────────┐  │  packages/context
                 │ registry · connectors · triggers · proposals + diffs ·     │  │  Distru sync → unified
                 │ policy · scopes · decisions · executor · undo · budgets ·  │  │  layer · profiles ·
                 │ audit — pure TypeScript behind ports                       │  │  learned memories
                 └──────────────────┬─────────────────────────────────────────┘  │
          ┌───────────────┬─────────┴────────┬──────────────┬───────────────┬────┴─────────┐
   connector-distru  connector-mcp      connector-headset  connector-email  connector-composio
   (REST, deep)      (governs any MCP,   (retail analytics, (vendor PO       (Gmail / Calendar
                      Distru preset)      read-only)         email)           + triggers)
```

### The harness (`packages/harness`)

| Concept | What it guarantees |
|---|---|
| **Connectors & registry** | A connector declares read tools, write actions and triggers for one system. Agents, MCP and evals all see one catalogue. Adding a system is writing a connector, not new safety code. |
| **Proposals & diffs** | Agents never write; they create changesets with field-level diffs (line items keyed by id, sparse-upsert aware). What's approved is exactly what's sent. |
| **Op references** | `{{op:0.purchase_number}}` lets an email cite a PO number that only exists after the PO is written; the diff shows the placeholder, the executor resolves it. |
| **Policy** | Rules are data (`max_total_value`, `auto_approve_below`, `high_risk_requires_approval`, `allowed_actions`, `email_recipient_domains`, …). Deterministic code, deny > needs approval > allow; editing a proposal re-runs policy. |
| **Scopes** | `read` / `propose` / `approve` for users, agents and MCP clients. Agents can never hold `approve`; the proposer can't approve their own proposal. |
| **Decisions** | Exactly once (compare-and-set); a concurrent second approval gets a conflict. |
| **Executor** | One durable step per op; idempotency key checked before every write; retries with backoff honouring `Retry-After`; read-after-write verification; partial failure is resumable. |
| **Undo** | Compensating proposals for reversible actions, within an undo window, through the same policy and approval. |
| **Triggers** | Signed webhooks and schedules verified, normalised and audited (accepted / ignored / rejected). |
| **Budgets & audit** | Per-agent and per-run step/token/cost/time limits; a typed, append-only audit trail of every event. |

### Connectors

| Connector | System | Notes |
|---|---|---|
| `connector-distru` | ERP | Velocity, inventory, vendors (+ derived lead times), purchase history, open orders, compliance check over lab results and Metrc packages; PO upsert, receiving tasks. ERP free text is wrapped as `untrusted_text`. |
| `connector-mcp` | Any MCP server | Reads pass through; writes are forced through propose/approve. Risk from tool metadata ("reaches Metrc/QuickBooks/email" → high). Distru preset for `mutate-purchase-order`, `mutate-product` (buyer caps), `mutate-task`. |
| `connector-headset` | Analytics | Retail sell-through trends; `demand_signal` blends wholesale and retail in code. |
| `connector-email` | Email | `send_vendor_po` — high risk, always needs approval; outbox locally, Resend in production. |
| `connector-composio` | Gmail, Calendar | Governed tools plus the Gmail new-message trigger. |
| `context` | Context layer | Incremental Distru sync (Distru's documented recipe, inside the free rate-limit window), vendor/product/customer profiles computed in code, memories learned from approvals with evidence and decay, onboarding policy suggestions. |

## Evals

`packages/evals` runs the real agents, workflows, connectors and mocks against scenarios written from real
use cases, with 25 typed assertion kinds (SKU flagged, compliance veto, injection flagged *and* not obeyed,
policy revision, zero writes on re-execute, retries honoured, Copilot answers without invented numbers…).

Model calls go through an **LLM emulator** (from danwo's emulator framework): record once against the real
API under a hard budget, then replay deterministically offline for $0 in CI. A changed prompt or tool fails
loudly as a stale recording instead of passing silently.

```bash
bun run evals          # offline replay, no secrets, used in CI
bun run evals:live     # against the real model
```

## Run locally

Requirements: bun ≥ 1.4, Docker, an Anthropic API key for live agent runs.

```bash
bun install
docker compose up -d                                   # Postgres on 127.0.0.1:5482
cp apps/agent/.env.example apps/agent/.env             # add ANTHROPIC_API_KEY
bun run --cwd apps/agent db:push && bun run --cwd apps/agent db:seed

bun run dev:mock          # Distru mock: REST /public/v1 + MCP /mcp      :4500
bun run dev:headset       # Headset retail analytics mock                 :4600
bun run dev:emulators     # Composio + Gmail + Slack + Resend emulators   :4700
bun run dev:agent         # agent server, API, /mcp, /api/inngest         :4111
bun run inngest:dev       # Inngest dev UI                                :8288
bun run dev:web           # dashboard                                     :3050
bun run studio            # Mastra Studio (optional)                      :3000
```

Open http://localhost:3050 and use the **Operator** / **Approver** demo buttons
(`operator@demo.dev` / `approver@demo.dev`, password `demo-password`).

**Demo flow:** Operator → *Start restock run* (pick one location) → watch the run's agent trace → Approver
→ *Approvals* → review Changes / Policy checks → approve (or click Approve in the Slack emulator) → watch it
execute and verify → *Audit log* → *Propose undo*. For the vendor-reply loop:
`curl -X POST localhost:4700/__emu/simulate/vendor-reply -d '{"vendor":"Mojave Pre-Roll Co.","kind":"partial"}'`.

**From Claude Code:** create an MCP token in *Settings → MCP access*, then add to `.mcp.json`:

```json
{ "mcpServers": { "ops-agent": { "type": "http", "url": "http://localhost:4111/mcp",
  "headers": { "Authorization": "Bearer ${OPS_MCP_TOKEN}" } } } }
```

### Real services

| Service | Switch from emulator to real |
|---|---|
| Distru REST | `DISTRU_BASE_URL`, `DISTRU_API_TOKEN` |
| Distru MCP | `DISTRU_MCP_URL=https://mcp.distru.com/mcp`, `DISTRU_MCP_KEY=distru_mcp_…` |
| Composio | `COMPOSIO_API_KEY` (unset `COMPOSIO_BASE_URL`) |
| Slack | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` (unset `SLACK_API_URL`) |
| Email | `RESEND_API_KEY`, `EMAIL_FROM` |
| Inngest | `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` (unset `INNGEST_DEV`) |

## Repository layout

| Path | What |
|---|---|
| `packages/harness` | The harness (no infrastructure imports; everything behind ports). |
| `packages/connector-*` | One package per external system. |
| `packages/context` | Context layer: sync, unified data, profiles, memories, onboarding. |
| `packages/distru-client` | Orval-generated Distru REST client (fetch mutator, pagination, `Retry-After`). |
| `packages/evals` | Scenario evals with record/replay. |
| `packages/emulators` | Provider emulators (Composio, Google, Slack, Resend, LLM), from danwo. |
| `packages/ui` | UI kit (Panda CSS), adapted from carbonme. |
| `apps/agent` | Mastra server on bun via `@mastra/hono`: agents, Inngest workflows, auth, API, MCP, A2A. |
| `apps/web` | Dashboard (TanStack Start, TanStack Query, Orval). |
| `apps/distru-mock` · `apps/headset-mock` · `apps/emulators` | Local stand-ins for Distru (REST + MCP), Headset, and Composio/Gmail/Slack/Resend. |

## Design decisions

- **Mastra through a server adapter, not `mastra dev`.** One bun entry serves Mastra's routes, Better Auth,
  Inngest and our typed API with a lean OpenAPI document for the web client
  ([server adapters](https://mastra.ai/docs/server/server-adapters) are a documented option). Mastra Studio
  still works standalone (`bun run studio`).
- **Plain code where a model is the wrong tool:** policy, reorder maths, demand blending, buyer caps, number
  validation of vendor replies, idempotency and verification are all deterministic.
- **Inngest for durability:** suspended approvals survive restarts; each executed op is a memoized step.
- **Relational context, not a vector store, for structured data:** profiles and memories are explainable and
  carry their evidence. Semantic recall over unstructured text is the next addition.
- **Mocks and emulators from public docs** so everything runs offline and in CI, and switching to real
  services is configuration.

## Status

Working: restock and vendor-reply workflows, Slack approvals, MCP server, undo, context layer (synced
profiles and learned memories, wired into the Planner, Vendor Liaison and Ops Lead), evals, dashboard,
prompt caching, agent-written proposal titles and summaries (validated by code), invoices / accounts
receivable in the mock with Copilot AR answers. In progress: semantic recall over vendor emails, public
deployment.
