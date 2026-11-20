# Design: governed agent writes for a cannabis ERP

This is the design behind Ops Agent, written the way I'd write it for a team about to build it: what we're
building and for whom, how it fits together, the parts that are hard to get right, and how the design holds
up when the constraints change. The README explains how to run it; this explains why it's shaped the way it
is.

---

## 1. The problem, from the user's side

**Who it's for.** A purchasing or operations lead at a cannabis distributor or brand that runs on Distru.
They own keeping product on the shelf without tying up cash, and they're the person who gets the call when a
dispensary can't get its order filled.

**What their week looks like.** Every morning they work out what's running low, decide how much to order from
which vendor, make sure nothing they reorder failed a lab test or is on hold in Metrc, raise purchase orders,
email vendors, and tell the warehouse what's coming. Then vendors reply with partial shipments, delays and
price changes, and half of that work starts again.

**Why "just give Claude the ERP" isn't enough.** Distru already ships an MCP server: 114 tools, 38 of them
writes, several of which reach Metrc, QuickBooks, LeafLink or a POS. That's a big step forward for asking
questions. For *acting*, the only guard is the assistant's per-call "Allow?" prompt. There's no view of the
whole change, no spending limit, no protection against the same write happening twice, no check that the
write landed, and no undo. That's acceptable for a person at the keyboard making one change. It isn't for
agents that run on a schedule, react to email, and change four systems at once.

**The job to be done.** *"Let the agents do the legwork, but make sure nothing changes in my business unless
someone who's allowed to has looked at exactly what's going to happen."*

## 2. Product and UX

### Principles

1. **The AI proposes; code executes.** Agents never hold a write tool. Every change is a proposal.
2. **Show the change, not the chat.** People approve a field-level diff of what will be written, not a
   paragraph of reasoning. Reasoning is there, but secondary.
3. **One decision per outcome.** A restock that touches the ERP, the online menu, email and tasks is one
   proposal with one approval, not fourteen pop-ups.
4. **Say no early.** Deterministic rules reject what's out of bounds before a person spends time on it.
5. **Leave a trail a regulator would accept.** Who proposed, which rules ran, who approved, what was written,
   and proof it landed.

### The surfaces

| Surface | For whom | What it does |
|---|---|---|
| **Approvals** | Approvers | Inbox of proposals; each opens as a record page with Overview, Changes, Policy checks and Audit trail tabs, and a details panel with the decision. |
| **Runs** | Everyone | A live trace of each run: which agent was handed what, every tool call, tokens, cost and time. |
| **Copilot** | Operators and approvers | Ask questions in plain English; the Ops Lead delegates to specialists and can start a run. |
| **Slack** | Approvers | Approval requests with Approve/Reject buttons, routed through the same decision path as the dashboard. |
| **MCP / A2A** | Engineers, other agents | The same governed capabilities from Claude Code, Codex or another agent, with scoped tokens. |
| **Audit log** | Ops, finance, compliance | Every event, with before/after values, idempotency keys and a detail drawer. |
| **Settings** | Approvers | Connectors and their health, policy rules, MCP tokens. |

### Key UX decisions

- **Roles over toggles.** Two roles: operators can start work and propose; approvers can decide. Nobody can
  approve their own proposal; no agent can approve anything. This is enforced in the harness, not the UI.
- **The approval card shows the blast radius.** Each change carries its system (ERP, Commerce, Email,
  Tasks), its risk, and whether it reaches a regulator or accounting system, so high-risk lines stand out.
- **Placeholders are honest.** A vendor email that cites a PO number that doesn't exist yet shows
  `{{op:0.purchase_number}}` in the diff and the resolved value after it's written. The approver sees exactly
  what was approved, never a value invented after the fact.
- **Undo is a proposal too.** Reversing a change goes through the same review. Things that can't be undone
  (a sent email) say so, with the reason.

## 3. System design

### Shape

```
 people & agents ──► agent team (Mastra) ──► harness (plain code) ──► connectors ──► business systems
 dashboard, Slack,    Ops Lead, Analyst,       propose → policy →        Distru REST,     Distru, Commerce
 Claude Code (MCP),   Planner, Compliance,     approve → execute →       Distru MCP,      menus, Headset,
 A2A, triggers        Critic, Vendor Liaison   verify → audit / undo     Headset, email,  email, Gmail,
                                                                          Composio, Slack  Slack
                         ▲
                 context layer: synced data, profiles, memories, semantic recall
```

### The harness is the product

The harness (`packages/harness`) knows nothing about cannabis or Distru. It's plain TypeScript behind ports,
so the same rules hold whether a change comes from a scheduled workflow, the Copilot, Slack or an MCP client.

| Part | Responsibility |
|---|---|
| **Connectors** | Declare read tools, write actions and triggers for one system: input schema, risk, required scope, how to load the current state, plan the exact request, execute, verify, compensate. |
| **Registry** | Merges connectors into one catalogue. Agent tools, MCP tools and evals are generated from it, so there's one source of truth for what exists and who may call it. |
| **Proposals** | A changeset of ops, each with input, the exact payload, the before state and a field-level diff (line items matched by id, aware of Distru's sparse upserts and set-replacing lists). |
| **Policy** | Rules are data, evaluated by code: value caps, allowed actions, recipient domains, auto-approval for small low-risk changes, high risk always needs a human. Deny beats needs-approval beats allow. |
| **Decisions** | Exactly once, through compare-and-set on a version; a second approver gets a conflict. Edits at approval time re-plan the op and re-run policy. |
| **Executor** | One durable step per op. Look up the idempotency key, write, read back and compare to the diff, record. Retries honour `Retry-After`. A failure leaves earlier ops done and the proposal resumable. |
| **Undo** | Builds a new proposal of compensating ops in reverse order, inside an undo window, through the same policy and approval. |
| **Triggers** | Signed webhooks and schedules: verified, normalised, de-duplicated and audited before they start anything. |
| **Budgets & audit** | Per-agent and per-run limits on steps, tokens, cost and time; a typed append-only audit trail. |

### The agent team

Six agents with narrow jobs and narrow scopes: the **Ops Lead** (supervisor, read-only, can start runs),
**Inventory Analyst**, **Procurement Planner** (the only one with propose tools), **Compliance Reviewer**,
**Policy Critic** and **Vendor Liaison**. Specialists return structured output, so the workflow around them
is deterministic. The restock workflow fans out analysts per warehouse and planners per vendor in parallel,
then runs a bounded review loop before it proposes once.

### Durable execution

Workflows run on Inngest through Mastra's Inngest integration. A run waiting for approval is suspended and
survives restarts and deploys; each executed op is a memoised step, so a crash mid-execution resumes where it
stopped and never repeats a write. A sweeper picks up approved proposals whose execution never started (for
example, if the queue was down at decision time).

### Context

Two kinds, kept apart on purpose. **Facts** (synced POs and orders, lead times, fill rates, price trends,
learned approver preferences) live in relational tables, computed in code and linked to their evidence.
**Prose** (vendor emails, PO notes, past conversations) goes into a vector index next to them for semantic
recall. Recall is context, not authority: passages are quoted and cited, never obeyed, and numbers in
proposals still come from ERP data and code.

### Trust boundaries

Everything from outside is data: product descriptions, PO notes, vendor emails, recalled passages. It's
wrapped as untrusted text with a "suspicious" flag when it looks like instructions. The defences are layered:
agents are told to report and never follow such text; a code plan guard rejects quantities outside the
analysed basis; vendor-reply numbers are validated against the PO; agent-written titles are checked against
the proposal; and policy plus a human sit in front of every write.

## 4. Implementation details worth calling out

- **Idempotency without an idempotency header.** Distru has none, so each op's key (a hash of proposal id
  and op index) is stamped into the record (a custom field where available, a description marker otherwise)
  and looked up inside Distru's free `updated_datetime` window before writing.
- **Rate limits as a budget.** Distru's list endpoints share a 3,000-call budget refilling at 5 a minute, free
  only when filtered to recent changes. Sync and lookups always stay inside the free window; the executor
  surfaces 429s to the harness so retries are audited.
- **Op references.** `{{op:N.field}}` lets later ops use earlier results. References can only point
  backwards, the diff keeps the placeholder, and the executor records each substitution.
- **Code where the model is the wrong tool.** Reorder maths, demand blending with retail data, per-buyer
  caps, vendor-reply validation, title validation and a pre-check that ends no-op runs with zero model calls.
- **Cost.** Prompt caching on system prompts and tools cut a default run by about 44%.
- **Evals.** About 20 scenarios run the real agents against emulated services, with 35 typed assertions.
  Model calls go through an emulator that records once and replays, so CI runs them for free and a changed
  prompt shows up as a stale recording rather than a silent pass.
- **Emulators.** Every outside service runs on an emulator built from scratch (danwo for Composio, Gmail,
  Slack, Resend and Claude; purpose-built Distru REST + MCP and Headset emulators). They let tests break
  things on purpose: rate-limit storms, Metrc failing after Distru saved, duplicate webhooks, injected text.

## 5. When a constraint changes

| If… | What changes | What doesn't |
|---|---|---|
| **Distru adds a native idempotency key** | The connector's `execute` sends it; `findByIdempotencyKey` becomes a direct lookup. | The executor, retries and audit are untouched. |
| **A customer wants auto-approval for routine reorders** | Raise `auto_approve_below` or add a vendor-scoped rule; the proposal still gets policy-checked and audited. | Writes still go through the executor and verification. |
| **Writes must reach Metrc directly** | Mark those actions high risk (always a human) and add a compensating action where Metrc allows one; otherwise they're listed as not undoable. | The diff, approval and verification flow. |
| **The approver is a team, not a person** | Add a quorum rule (n of m approvers) as a decision policy; compare-and-set already prevents races. | Agents still can't approve; proposers still can't approve their own. |
| **A new system (CRM, sheets, accounting)** | Write a connector, or point the MCP bridge at its MCP server with a small preset for risk and verification. | Safety code, UI and evals harness. |
| **Volume grows 100×** | Run more workers (Inngest concurrency per account), shard sync per account, move recall to a dedicated index. | The proposal model and its guarantees. |
| **Distru's MCP becomes the only interface** | The MCP bridge already governs it: reads pass through, writes become proposals with risk from tool metadata. | Everything above the connector layer. |
| **Model behaviour drifts** | Evals catch it in CI; the plan guard, validators and policy keep a bad suggestion from becoming a bad write. | The guarantee that nothing writes without approval. |

## 6. What I'd do next

1. **A real account.** Run the connectors against a Distru sandbox and Distru's MCP to find where the
   emulators were too kind.
2. **Approval UX at scale.** Batch approvals with per-line overrides, and approval delegation rules.
3. **More playbooks on the same harness.** Collections (overdue invoices, chase emails, payment plans),
   expiring inventory, inbound order cleanup.
4. **Learning loops.** Turn repeated approver edits into suggested policy changes, reviewed like everything
   else.
5. **Deployment and observability.** Public demo, OpenTelemetry export of the run traces, and an on-call view
   of failed executions.
