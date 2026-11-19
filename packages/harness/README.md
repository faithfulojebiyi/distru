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
| Diff | `diff(before, payload)` → `[{ path, kind, before, after }]`; sparse-upsert aware; `items` keyed by `id` (unmatched = added as `new:i`, omitted ids = removed). `summarizeDiff`, `formatPath`, `matchesExpected` (read-after-write check). |
| Policy | Rules are data `{ key, params, enabled }`. Built-ins: `max_total_value`, `allowed_actions`, `vendor_allowlist`, `auto_approve_below`, `high_risk_requires_approval`. deny > needs_approval > allow; default needs_approval; unknown/invalid rules fail closed. |
| Proposals | `draft → pending_approval \| auto_approved \| denied`, `pending_approval → approved \| rejected`, `approved \| auto_approved → executing → executed \| failed`, `failed → executing` (resume). |
| Decisions | `decide()` needs `approve`, uses compare-and-set (losers get `DecisionConflictError`), edits re-plan + re-diff + re-run policy (deny blocks with `PolicyDeniedError`), separation of duties on by default. |
| Executor | Per op: `findByIdempotencyKey` → `execute` → `verify`, retried with full-jitter backoff (port-supplied `Retry-After` wins), stops at first non-retryable failure with partial results. Re-running is always safe. |
| Budgets | `new Budget({ maxSteps, maxTokens, maxCostUsd, maxWallClockMs })`, `charge()`, `BudgetExceededError`, `budget.signal`, `abortable`, `anySignal`. |
| Audit | Typed `AuditEvent` union (`proposal.created`, `policy.evaluated`, `proposal.decided`, `op.executed`, `op.deduplicated`, `op.verified`, `op.verify_failed`, `op.retry`, `op.failed`, `proposal.failed`, `budget.exceeded`, …). |

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
