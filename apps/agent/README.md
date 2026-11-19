# @ops/agent

The Ops Agent backend: a **Mastra server on Bun**. There is no separate backend framework. Agents,
workflows, memory, storage and tracing come from Mastra. We add Better Auth, a handful of typed custom
routes, and the Inngest serve endpoint.

## Why a custom Bun entry instead of `mastra dev` / `mastra build`

We run our own entry (`src/index.ts`) that serves one Hono app with `Bun.serve`, and mount Mastra on it
with the official Hono adapter (`@mastra/hono` → `MastraServer`).

| Need | `mastra dev`/`build` | Custom entry + `@mastra/hono` |
|---|---|---|
| Custom routes under `/api/*` (`/api/me`, `/api/proposals`, ...) | `registerApiRoute` refuses paths under the `apiPrefix` (`/api`). We would have to move Mastra's built-ins to e.g. `/_mastra` | Any path. Mastra keeps its default `/api/agents`, `/api/workflows`, ... |
| `/api/inngest` and `/api/auth/*` | Same `/api` restriction | Mounted directly on the app |
| OpenAPI for *our* routes, used by Orval | Mastra's generated doc includes every built-in route (hundreds), and `registerApiRoute` `openapi` metadata is written by hand | `@hono/zod-openapi`: the zod schemas validate requests **and** generate `/api/openapi.json` with only our routes. `.meta({ id })` becomes `components/schemas/<id>` |
| CORS with credentials | `server.cors` | `hono/cors`, with full control over ordering |
| Run on Bun in production | `mastra build` produces a Node-oriented bundle | `bun src/index.ts`. Same code in dev and prod |

What we give up: `mastra dev`'s bundled Studio and file-based agent discovery. Agents and workflows are
registered in code in `src/mastra/index.ts`. With a server adapter, `mastra.startWorkers()` must be
called ourselves (done in `src/index.ts`).

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
│   │   ├── schema.ts         Drizzle: Better Auth tables + proposal, proposal_op, approval, audit_event,
│   │   │                     policy_rule, eval_run
│   │   ├── client.ts         drizzle(postgres-js)
│   │   └── seed.ts           demo users + default policy rules (idempotent)
│   ├── services/proposals.ts Drizzle implementations (list/get/decide with row lock, audit list)
│   └── mastra/
│       ├── index.ts          Mastra instance: PostgresStore (schema `mastra`), tracing, auth
│       ├── inngest.ts        Inngest client + init() → Inngest-backed createWorkflow/createStep
│       ├── agents/ops-agent.ts  placeholder supervisor agent (model router string)
│       └── workflows/hello.ts   2-step workflow with one suspend/resume point
├── scripts/verify-hello-workflow.ts   e2e: sign in → start → suspended → resume → success
├── test/                     bun tests: role guard + decision route authorization + OpenAPI shape
└── drizzle.config.ts         manages the `public` schema only
```

## Routes

| Path | Auth | Notes |
|---|---|---|
| `GET /api/health` | public | includes a DB ping |
| `GET /api/me` | session | `{ id, email, name, role }` |
| `GET /api/proposals?status=&limit=` | session | reads from Postgres |
| `GET /api/proposals/:id` | session | ops + decision |
| `POST /api/proposals/:id/decision` | **approver** | `{ decision: 'approved'\|'rejected', reason? }`. Row lock, one decision per proposal (409 on a second one), writes an audit event. Resuming the workflow comes on day 3 |
| `GET /api/audit-events` | session | newest first |
| `GET /api/runs` | session | placeholder (empty list) until the run timeline lands |
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
bun run db:push                            # drizzle-kit push (public schema)
bun run db:seed                            # operator@demo.dev / approver@demo.dev, password demo-password
bun run dev                                # http://localhost:4111

# second terminal: Inngest dev server (UI on http://localhost:8288)
bun run inngest:dev                        # (apps/agent) uses npx, see "Known issues"
bun run verify:hello                       # suspend → resume through Inngest
bun test
```

Mastra creates its own tables in the `mastra` schema on first boot (`PostgresStore({ schemaName: 'mastra' })`).
Traces go to `mastra.mastra_ai_spans` through `MastraStorageExporter`.

## Production

`bun run start` (`NODE_ENV=production bun src/index.ts`). At boot the env check requires
`INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` and refuses to start if `INNGEST_DEV` is set. Email sign-up
is disabled. Point Inngest Cloud at `https://<host>/api/inngest`. Run behind a proxy that sets
`X-Forwarded-For`, because Better Auth's rate limiter reads the client IP from it.

## Known issues

- `bunx inngest-cli@latest` fails because bun skips the package's postinstall, which downloads the binary.
  The root `inngest:dev` script uses `bunx`, so for now use `bun run --cwd apps/agent inngest:dev` (npx
  with scripts enabled).
- `@mastra/evals` declares `vitest` as a peer. Our tests use `bun test`, so the peer stays unmet until
  scorers are run through vitest (if ever).
