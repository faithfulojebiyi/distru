# @ops/harness

A framework-agnostic **action harness for agents that write to an ERP**. Agents never write: they
*propose* changesets with field-level diffs; a deterministic policy engine gates them; a human with
the `approve` scope decides exactly once; an idempotent executor applies them one durable step per
op, verifies each write by reading it back, and audits everything. Pure TypeScript + zod. No Mastra,
Postgres, Inngest or HTTP imports: every side effect goes through a port.

## Concepts

| Concept | API |
|---|---|
| Scopes & principals | `Scope = read \| propose \| approve`; `Principal { kind: user \| agent \| mcp-client, id, scopes }`. `userPrincipal(id, 'operator' \| 'approver')`, `agentPrincipal(id)`, `mcpClientPrincipal(id, scopes)`, `assertScope`. Agents can never approve (schema + runtime check). |
| Actions & read tools | `defineAction({ name, resource, risk, input, loadBefore, plan, execute, verify, findByIdempotencyKey, valueOf?, vendorIdsOf?, diff? })`, `defineReadTool({ name, input, run })`, `new Registry({ actions, readTools })`, `registry.catalog(principal?)` → JSON Schemas for Mastra/MCP. |
| Connectors | `defineConnector({ id, system, description, readTools, actions, health? })` plugs one system (`erp \| crm \| email \| calendar \| spreadsheet \| analytics \| compliance \| other`) into the registry. `Registry.fromConnectors([...])` (or `new Registry({ connectors })`) namespaces names by connector id (`distru.velocity_report` → tool `distru_velocity_report`, `distru.purchases.upsert` → `propose_distru_purchases_upsert`); catalog entries carry `connector: { id, system }`; `registry.connectors()`, `registry.connectorOf(name)`, `registry.health(ctx)`. |
| Diff | `diff(before, payload)` → `[{ path, kind, before, after }]`; sparse-upsert aware; `items` keyed by `id` (unmatched = added as `new:i`, omitted ids = removed). `summarizeDiff`, `formatPath`, `matchesExpected` (read-after-write check). |
| Policy | Rules are data `{ key, params, enabled }`. Built-ins: `max_total_value`, `allowed_actions`, `vendor_allowlist`, `auto_approve_below` (`{ amount, max_risk?: 'low' \| 'medium' }`, default `low`; `maxValue` is a legacy alias for `amount`; high-risk ops are never auto-approved), `high_risk_requires_approval`. deny > needs_approval > allow; default needs_approval; unknown/invalid rules fail closed. |
| Proposals | `draft → pending_approval \| auto_approved \| denied`, `pending_approval → approved \| rejected`, `approved \| auto_approved → executing → executed \| failed`, `failed → executing` (resume). |
| Decisions | `decide()` needs `approve`, uses compare-and-set (losers get `DecisionConflictError`), edits re-plan + re-diff + re-run policy (deny blocks with `PolicyDeniedError`), separation of duties on by default. |
| Executor | Per op: `findByIdempotencyKey` → `execute` → `verify`, retried with full-jitter backoff (port-supplied `Retry-After` wins), stops at first non-retryable failure with partial results. Re-running is always safe: an op that was written but failed `verify` (e.g. Distru saved it, Metrc rejected it) keeps its record id, and a resume re-verifies that record instead of writing again (`op.deduplicated` with `dedupedBy: executor_record`). |
| Op references | A later op may use a value that only exists once an earlier op ran: `{{op:<i>.recordId}}` or `{{op:<i>.<output>}}` inside any payload string (`opRef(i, field)`). See "Op references" below. |
| Value | `valueOf(payload)` (own hook only) gives an op's money value; `moneyless: true` makes it 0 (emails, tasks, catalog settings) so `max_total_value` still checks the proposal; otherwise null (unknown → the cap asks for a human). `opValueOf(action, payload)`. |
| Budgets | `new Budget({ maxSteps, maxTokens, maxCostUsd, maxWallClockMs })`, `charge()`, `BudgetExceededError`, `budget.signal`, `abortable`, `anySignal`. |
| Triggers | `defineTrigger<TEvent>({ id, source, description, eventName, event, secret?, verify, normalize, untrustedFields? })` (signed webhook) or `{ delivery: 'schedule', cron, normalize }`; `defineConnector({ triggers })` (ids `<connector>.<name>`, `connectorId` stamped); `new Registry({ triggers })`, `registry.triggers()` / `trigger(id)`; `ingestWebhook(source, id, rawBody, headers, secrets, { audit, clock })` → accepted `{ name, id, data }` / ignored / rejected (401/400) + `trigger.received` / `trigger.rejected`. See "Triggers" below. |
| Audit | Typed `AuditEvent` union (`proposal.created`, `policy.evaluated`, `proposal.decided`, `op.executed`, `op.deduplicated`, `op.verified`, `op.verify_failed`, `op.retry`, `op.failed`, `proposal.failed`, `budget.exceeded`, …). |
| Undo | Optional `compensate` / `planCompensation` / `canCompensate` / `irreversible` on actions; `harness.undo({ ctx, principal, proposalId, opIndexes?, reason })` → a NEW compensating proposal (`<action>.undo` ops, reverse order, `meta.undoOf`, never auto-approved); `harness.undoInfo(p)` → per-op `canUndo` + reason; `undoWindowMs`. See "Undo / rollback" below. |

**Resume and headlines.** `harness.requestResume({ principal, proposalId, reason })` (approve scope; only
`failed` proposals, `isResumable(p)`) audits `proposal.resume_requested`; the app then runs `execute` again,
which skips executed ops. Proposals carry an optional `summary` next to `title` (title ≤ 120 chars, single
line, `InputValidationError` otherwise; never truncated). An edited approval keeps the agent's original ops
in `meta.originalOps` (learners compare proposed vs approved).

## Usage

```ts
import { createHarness, defineAction, Registry, agentPrincipal, userPrincipal, matchesExpected } from '@ops/harness';

const upsertPurchase = defineAction({
  name: 'purchases.upsert', resource: 'purchases', risk: 'medium',
  description: 'Create or update a purchase order',
  input: PurchaseInput,                                   // zod schema the agent fills in
  loadBefore: (ctx: Ctx, input) => input.id ? ctx.distru.getPurchase(input.id) : null,
  plan: (ctx, input, before) => toUpsertBody(input, before), // exact request body
  execute: async (ctx, body, key) => {
    const po = await ctx.distru.upsertPurchase({ ...body, notes: stampKey(body.notes, key) });
    return { recordId: po.id, record: po };
  },
  findByIdempotencyKey: (ctx, key) => ctx.distru.findPurchaseByNote(key),
  verify: async (ctx, id, body) => matchesExpected(await ctx.distru.getPurchase(id), body),
  valueOf: (body) => sum(body.items, (i) => i.quantity * i.unit_price),
  vendorIdsOf: (body) => [body.vendor_id],
});

const harness = createHarness<Ctx>({
  registry: new Registry({ actions: [upsertPurchase] }),
  store, audit, policyRules,                              // ports (Postgres-backed in apps/agent)
  steps: { run: (id, fn) => step.run(id, fn) },           // one durable Inngest step per op
  errors: { isRetryable: (e) => isHttp(e, 429, 500), retryAfterMs: (e) => retryAfterHeader(e) },
});

const p = await harness.propose({ ctx, principal: agentPrincipal('planner'), ops: [{ action: 'purchases.upsert', input }] });
// p.status: 'pending_approval' | 'auto_approved' | 'denied'; p.ops[0].diff, p.policy.reasons
await harness.decide({ ctx, principal: userPrincipal(user.id, 'approver'), proposalId: p.id, decision: 'approve' });
const done = await harness.execute({ ctx, proposalId: p.id, budget });  // 'executed' | 'failed'
```

## Op references (cross-tool proposals)

A proposal can chain writes across systems: "create the PO, then email the vendor *the PO number*,
then create a receiving task *linked to the PO*". The PO number only exists after execute, so:

- An action may export values of the record it wrote: `outputs(record, recordId) => ({ purchase_number })`.
  The executor stores them in `op.result.outputs` (also on a deduplicated write).
- A later op's input/payload references them with a placeholder in any string:
  `{{op:0.purchase_number}}`, `{{op:0.recordId}}` (`opRef(0, 'purchase_number')`). A string that is
  exactly one placeholder takes the value's own type.
- **Propose/edit**: references may only point at an *earlier* op (`assertBackwardRefs`, else
  `InputValidationError`). The stored payload and the diff keep the placeholder, so the approver sees
  exactly what will be substituted, never a guess.
- **Execute**: ops run in order and stop at the first failure, so a referenced op has always succeeded.
  The executor resolves the placeholders from the earlier ops' persisted results (also after a resume),
  re-validates the resolved payload against `action.payload`, runs `execute` and `verify` with it, and
  records every substitution in `op.result.resolved` (`{ "{{op:0.purchase_number}}": "PO-1042" }`) and
  on the `op.executed` audit event. An unresolvable reference fails the op with
  `UnresolvedReferenceError` (`code: unresolved_reference`, not retried).
- Idempotency is unaffected: keys are per (proposal, op index), never derived from resolved values.

## Triggers (inbound events)

Triggers are how the outside world starts agent work: signed webhooks (a Distru ORDER CREATE, a
Composio Gmail message, a Slack button click) and schedules (the morning restock scan). They live in
the registry next to actions, so the catalogue, the audit trail and the app all see the same list.

```ts
import { defineTrigger, ingestWebhook, headerValue, hmacSha256Hex, timingSafeEqualString } from '@ops/harness';

const orderCreated = defineTrigger<OrderEvent>({
  id: 'shop.order_created', source: 'shop', description: 'A shop order was created',
  eventName: 'shop/order.created', event: OrderEventSchema, secret: 'SHOP_SECRET', untrustedFields: ['note'],
  // Over the RAW body; never throw for a bad request.
  verify: async (rawBody, headers, secrets, { now }) => (await validSignature(rawBody, headers, secrets.SHOP_SECRET, now))
    ? { ok: true, webhookId: headerValue(headers, 'x-id')!, raw: JSON.parse(rawBody) }
    : { ok: false, reason: 'bad_signature' },
  normalize: (raw, { eventId }) => (isCreate(raw) ? toEvent(raw, eventId) : null), // null = acknowledged, ignored
});
const shop = defineConnector({ id: 'shop', system: 'other', description: 'Shop', triggers: [orderCreated] });

// In the route:
const r = await ingestWebhook(registry, 'shop.order_created', await req.text(), req.headers, { SHOP_SECRET }, { audit, clock });
if (r.status === 'rejected') return json({ error: r.reason }, r.httpStatus);   // 401 signature / 400 payload
if (r.status === 'accepted') await inngest.send(r.event);                      // { name, id: 'shop.order_created:<webhook id>', data }
```

- `ingestWebhook` verifies, normalizes, validates the event with the trigger's zod schema and audits:
  `trigger.received { triggerId, source, connectorId, eventName, webhookId, untrustedFields, ignored }` or
  `trigger.rejected { triggerId, source, connectorId, reason, message }` (actor `system:trigger:<id>`,
  `proposalId: null`). A missing secret fails closed (`missing_secret`). A throwing `verify` is a rejection.
- The queue event `id` is `<trigger id>:<webhook id>`, so a redelivery dedupes (Inngest keeps ids 24 h).
- `triggerSource([...])` builds a source from a plain list (e.g. one route that only knows its trigger).
- Helpers: `headerValue` (case-insensitive, `Headers` or records), `hmacSha256Hex`, `timingSafeEqualString`.
- Schedule triggers (`delivery: 'schedule'`, `cron`) are catalogue entries for the queue's cron; `ingestWebhook` refuses them.

## Undo / rollback

An undo is never a write of its own: `harness.undo()` turns executed ops into a **new proposal** of
compensating ops, which then goes through policy, a human decision and the executor like any change.

```ts
const u = await harness.undo({ ctx, principal: userPrincipal(id, 'operator'), proposalId, reason: 'Vendor cancelled' });
// u.status === 'pending_approval' (always: rule `undo_requires_approval`); u.meta.undoOf = { proposalId, opIndexes }
// u.meta.notUndoable = [{ opIndex, reason: 'The email was already delivered…' }]
const info = await harness.undoInfo(proposalId); // { available, ops: [{ opIndex, canUndo, reason, undoProposalId }], undoProposalId, until }
```

- **Action hooks** (all optional): `canCompensate(op)` (pure: can this executed op be undone?),
  `planCompensation(ctx, op, result) → { current, target, summary?, value? }` (reads the record *now*;
  `target: null` = delete; throw `InputValidationError` when it moved on, e.g. a received PO),
  `compensate(ctx, op, result) → { recordId, record }` (idempotent by value: deleting twice or
  restoring twice succeeds), `irreversible` (why an action without `compensate` can't be undone).
  Hooks see the op with `{{op:N.field}}` references already resolved from the original proposal.
- **Derived actions**: the registry derives `<action>.undo` for every action with `compensate`
  (`registry.action('distru.purchases.upsert.undo')`); they are not in the catalog, so no agent gets a
  `propose_*` tool for them. Plan → `before` = current record, payload target, diff current → target;
  verify re-plans and checks the record equals the target (or is gone).
- **Order and coverage**: ops are undone in reverse order (a task linked to a PO goes before the PO).
  The original proposal records `meta.undo.proposals` (reserved by compare-and-set before the undo
  proposal is created) and gets a `proposal.undo_proposed` audit event. An op covered by a live undo
  proposal can't be undone twice; a rejected/denied undo frees it again. An undo can't be undone.
- **Policy**: `allowed_actions` allows `<action>.undo` when `<action>` is allowed (or listed
  explicitly); value rules see the compensation's own value (0 for a delete); separation of duties
  applies to the undo's decision. Only `executed` / `failed` proposals, within `undoWindowMs`.

## Error routing and a live registry

- The executor passes `ErrorContext { action, connectorId }` to the `ErrorClassifier`.
  `routeErrorClassifier({ distru, email, distru_mcp })` picks the classifier of the failing op's
  connector (fallback without a context: retryable if any says so).
- `createHarness({ registry: () => current })` reads the registry on every use, so an app can rebuild
  it (e.g. when an MCP connector's tool list changes) without rebuilding the harness.

## Connectors and per-connector context

Each connector declares the context slice it needs with `ConnectorContext<'id', Client>` =
`{ connectors: { id: Client } }`, and its hooks read `ctx.connectors.<id>`. Contexts compose by
intersection, so the app passes one object that satisfies all of them:

```ts
import { Registry, createHarness, defineConnector, type ConnectorContext } from '@ops/harness';

type DistruCtx = ConnectorContext<'distru', DistruClient>;
const distruConnector = defineConnector<DistruCtx>({
  id: 'distru', system: 'erp', description: 'Distru ERP',
  readTools: [velocityReport], actions: [upsertPurchase],          // connector-local names
  health: async (ctx) => ({ ok: true, detail: `${(await ctx.connectors.distru.listLocations()).data?.length} locations` }),
});

const registry = Registry.fromConnectors([distruConnector, emailConnector]); // Registry<DistruCtx & EmailCtx>
const ctx = { connectors: { distru: createDistruClient(cfg), email: mailer }, tenantId };   // must satisfy both
const harness = createHarness({ registry, store, audit, policyRules, errors });
await harness.propose({ ctx, principal, ops: [{ action: 'distru.purchases.upsert', input }] });
```

Type safety: `ConnectorDefinition<TCtx>` is contravariant in `TCtx` (via a type-only `__context`
marker), so `new Registry<AppCtx>({ connectors: [c] })` only compiles when `AppCtx` provides what
`c` needs, and `fromConnectors` infers the intersection (`ConnectorsContext<[...]>`). Plain
`actions`/`readTools` can still be registered alongside connectors. `summarize(input, payload, ctx,
before)` may be async (e.g. to resolve a vendor name).

## Ports the app implements

| Port | Contract | Production mapping |
|---|---|---|
| `ProposalStore` | `create`, `get`, `compareAndSet(next, expectedVersion) → boolean` | Drizzle `proposal` + `proposal_op` in one tx; `UPDATE … WHERE id = $1 AND version = $2`, return `rowCount === 1`. |
| `AuditSink` | `append(event)` | INSERT into `audit_event` (append-only). |
| `PolicyRuleSource` | `list() → PolicyRuleConfig[]` | SELECT from `policy_rule` (Settings page edits rows). |
| `StepRunner` | `run(stepId, fn)` | Inngest `step.run` / Mastra workflow step. Step ids: `proposal:<id>:start`, `:op:<i>`, `:finish`. |
| `ErrorClassifier` | `isRetryable(err)`, `retryAfterMs?(err)` | Distru client: 429/5xx retryable; 429 `Retry-After` header. |
| `Clock`, `IdGenerator` | `now()`, `sleep()`; `() => string` | Defaults: system clock, `crypto.randomUUID`. |
| `TCtx` | anything | Distru client + tenant, passed to every action hook. |

**MCP / Mastra:** `registry.catalog(principal)` returns each tool's name (`propose_purchases_upsert`,
`inventory_search`), description, required scope and JSON Schema, filtered to the caller's scopes.
Write tools call `harness.propose`; `approve_proposal` calls `harness.decide` with the MCP client's
principal (only tokens granted `approve`). Read tools go through `registry.runReadTool`.

In-memory adapters for tests and evals: `InMemoryProposalStore`, `InMemoryAuditSink`,
`StaticPolicyRules`, `FakeClock`, `MemoStepRunner` (replay semantics), `sequentialIds`.

```sh
bun test          # from packages/harness
bun run typecheck
```
