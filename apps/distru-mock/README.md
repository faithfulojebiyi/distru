# distru-mock

A mock of Distru built from Distru's own docs, with one in-memory store behind two surfaces:

- **REST** `/public/v1/*`: matches the schemas in `packages/distru-client/openapi.json` (checked by `test/schema.test.ts`).
- **MCP** `/mcp`: a mock of `https://mcp.distru.com/mcp` (Streamable HTTP).

A write made on either surface shows up on the other. For example, a PO created with `distru-mutate-purchase-order` is listed by `GET /public/v1/purchases`.

```bash
bun run dev            # http://localhost:4500  (PORT, MOCK_SCENARIO, MOCK_NOW, WEBHOOK_URL, WEBHOOK_SECRET, ...)
bun test               # REST, schema, client integration, MCP and menu tests
bun run gen:mcp-schemas  # regenerate src/mcp/schemas.gen.ts from docs/research/mcptools/*.md
```

## REST

- **Endpoints:** inventory-velocity report, inventory, products, companies, locations, orders, purchases (upsert, plus `POST /purchases/{id}/pdf`), metrc packages, test results, batches, tasks (list, get, upsert, delete), users, custom fields (list, get, create; `custom_data` on purchases is validated, returned and filterable for dropdown/checkbox fields), deleted records, activity and record history. Activity and record history are fed by both REST writes (`PUBLIC_API`) and MCP writes (`MCP`).
- **List rate limit:** a token bucket of 3,000 calls refilling at 5 per minute. It applies to the paginated lists with an `updated_datetime` filter. A call whose `updated_datetime` lower bound is within the last 30 days is free and is never refused. `/activity` is free when it has no `changed_datetime`. Get-by-id, `/inventory`, reports and Metrc lists are unlimited. Responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`; a refused call gets a 429 with `Retry-After`.
- **PDF limit:** 20 successful PDFs per minute and 1,000 per day, as sliding windows.
- **Webhooks:** ORDER, PURCHASE, PRODUCT, PACKAGE.
  - PRODUCT fires when a company-wide active or reserved quantity changes. PACKAGE fires when a package is created or its quantity or status changes.
  - Deliveries for one record go out in order, one at a time. `object` is fetched when the webhook is sent.
  - Failed deliveries are retried about 10 times over about 4 hours (`MOCK_WEBHOOK_RETRY_DELAYS_MS` or `webhookRetryDelaysMs` to shorten).
  - The store has no invoices, so no INVOICE webhooks fire.
- **Control plane:**
  - `GET /__mock/state` shows counts, activity, outbox, MCP telemetry, menus and buyer caps.
  - `GET` or `POST /__mock/config` changes:
    - `rate_limit`: `fail_next`, `every`, `retry_after`, plus `list.{enabled,capacity,refill_per_minute,free_window_days,tokens}` and `pdf.{per_minute,per_day}`;
    - `mcp_rate_limit`;
    - `webhook_url` and `webhook_retry_delays_ms`;
    - `metrc_fail_next`.
  - `POST /__mock/reset` and `POST /__mock/simulate/order` (takes an optional `menu_id` and `placed_by: buyer|sales_rep`).

## MCP

- **URL:** `http://localhost:4500/mcp`.
- **Auth:** `Authorization: Bearer distru_mcp_<anything>`. Default key `distru_mcp_mock`. Set `DISTRU_MCP_MOCK_KEY` to require one exact key. Anything else gets a 401.
- **Server:** built on `@modelcontextprotocol/server` 2.4.0 (`createMcpHandler`, stateless). It serves the 2026-07-28 protocol and falls back to stateless 2025-era serving, so MCP SDK 1.x clients work too.
- **Distru conventions:**
  - Every tool requires `intent` and `userSatisfactionEstimate`. Both are logged to `/__mock/state` → `mcp.telemetry`; a missing or invalid value doesn't fail the call.
  - `x-distru-filter-tool-tags: read` hides the write tools.
  - Ids carry a prefix, mapped to REST ids as `<prefix>_<rest id>`. Bare UUIDs are accepted; a prefix of the wrong kind is refused.
  - Fields are camelCase.
  - Searches return `{items, hasMore, nextCursor, totalCount}` (limit 10 by default, 100 at most). A cursor only works with the same arguments.
  - Reports return `rows`, `meta` and `nextCursor`, and take `maxRowsLimit`.
- **Limits per user:** 40 calls back to back, refilling at 120 per minute. 3,000 per hour. 20 writes per minute. 20 PDFs per minute and 1,000 per day. 6 calls in flight per key. A batch of more than 6 calls gets a 400. A refused call gets HTTP 429 with `Retry-After` and a JSON-RPC error naming the limit; accepted calls carry `RateLimit-Remaining` and `RateLimit-Reset`.
- **Tool metadata:**
  - Each write tool carries `_meta.distru = { kind: 'write', reaches: [...], irreversible }` plus MCP annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`).
  - Descriptions are Distru's "What the AI reads" text, word for word.
  - Input schemas are generated from the Inputs tables of the tool pages.

| Tool (`distru-` prefix omitted) | Kind | Reaches |
|---|---|---|
| get-me, search-products, get-product, report-inventory-valuation, report-inventory-assets, search-purchase-orders, get-purchase-order, search-companies, get-company, search-packages, get-package, search-test-results, search-sales-orders, get-sales-order, search-tasks, search-users, get-record-history, search-activity, search-menus, get-menu-settings, search-menu-products, search-menu-collections | read | none |
| mutate-purchase-order (CREATE/UPDATE/DELETE) | write | quickbooks |
| adjust-inventory | write | biotrack, metrc |
| email-pdf (added to an outbox, never sent) | write | email |
| mutate-task, mutate-menu (CREATE/UPDATE; menus can't be deleted), mutate-product | write | none |

The per-buyer order cap is the product field `maxMenuBuyerOrderQuantity`, set with `distru-mutate-product`. On a menu order placed by a buyer it is enforced by `/__mock/simulate/order`; sales reps are exempt.

### Pointing a client at real Distru

Use the same client with `https://mcp.distru.com/mcp` and a real `distru_mcp_…` key (Distru → API settings; MCP has to be enabled for the account by a Distru rep). The connector-mcp preset reads `DISTRU_MCP_URL` and `DISTRU_MCP_KEY`, so set `DISTRU_MCP_URL=http://localhost:4500/mcp` to use the mock and unset it to use Distru. Things only the mock has: `/__mock/*`, the `metrc_fail_next` / `fail_next` / `latency_ms` toggles, and the outbox. Real Distru also offers OAuth ("Sign in with Distru") and linked accounts (a required `account` input), which the mock ignores.
