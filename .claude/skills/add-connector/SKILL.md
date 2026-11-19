---
name: add-connector
description: Add a new external system (CRM, spreadsheet, calendar, analytics, compliance…) to the harness as a connector package with governed read tools and write actions. Use when asked to integrate, connect or support another tool or MCP server.
---

# Add a connector

A connector plugs one system into the harness. Every write it defines goes through
propose → policy → approve → execute → verify → audit; you never write safety code.

## Decide first

- **Does the system have an MCP server?** Prefer `@ops/connector-mcp` (`createMcpConnector`) with a
  preset: classification, risk and resolvers only. Write a bespoke package only for deep integrations.
- **Which operations are writes?** Anything that changes state outside our database, including email.
  When unsure, it is a write (fail closed).
- **Risk:** `high` when it reaches a regulator, accounting, money, or a person outside the company
  (Metrc, QuickBooks, payments, email) or cannot be undone; `medium` for reversible business writes;
  `low` only for trivially reversible internal writes.

## Steps

1. `packages/connector-<id>/` with `package.json` (`@ops/connector-<id>`, type module, exports
   `./src/index.ts`, `test` + `typecheck` scripts) and a tsconfig copied from `connector-distru`.
2. A client/port for the system behind an interface so tests can stub it.
3. Read tools with `defineReadTool`: zod input **and** output, outputs trimmed for an LLM (ids it needs,
   no raw dumps). Wrap free text as untrusted (`connector-distru/src/untrusted.ts`).
4. Write actions with `defineAction`: `loadBefore`, `plan` (the exact request body), `execute(ctx,
   payload, idempotencyKey)`, `findByIdempotencyKey`, `verify`, `summarize`, and `valueOf` /
   `vendorIdsOf` when policy needs them. Add `compensate` only if the system supports a real undo.
5. Export `defineConnector({ id, system, description, readTools, actions, health })` and a context
   factory reading env.
6. Tests: the full harness flow with in-memory adapters (propose → policy → decide → execute →
   re-execute writes nothing), a crash-after-write dedupe, verify mismatch, and untrusted text.
7. Register it in `apps/agent/src/harness/registry.ts` (`Registry.fromConnectors([...])`) and add its
   env vars to `apps/agent/.env.example`.
8. Add eval scenarios that exercise its writes.

Reference implementation: `packages/connector-distru`.
