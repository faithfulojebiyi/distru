# distru-mock

A mock of Distru built from Distru's own docs, with one in-memory store behind two surfaces:

- **REST** `/public/v1/*`: matches the schemas in `packages/distru-client/openapi.json` (checked by `test/schema.test.ts`).
- **MCP** `/mcp`: a mock of `https://mcp.distru.com/mcp` (Streamable HTTP).

A write made on either surface shows up on the other. For example, a PO created with `distru-mutate-purchase-order` is listed by `GET /public/v1/purchases`.

```bash
bun run dev            # http://localhost:4500  (PORT, MOCK_SCENARIO, MOCK_NOW, MOCK_PO_VARIATION, WEBHOOK_URL, WEBHOOK_SECRET, ...)
bun test               # REST, schema, client integration, MCP and menu tests
bun run gen:mcp-schemas  # regenerate src/mcp/schemas.gen.ts from docs/research/mcptools/*.md
```

## Seeded world

`src/seed.ts` builds one deterministic distributor (3 own locations, 6 vendors, 6 dispensary customers,
43 products, 12 months of sales, a year of purchase orders, accounts receivable). Scenarios
(`MOCK_SCENARIO`) only flip data; ids stay the same.

- **default**: the 8 canonical SKUs (`LOW_STOCK_SKUS`) are below their reorder point company-wide and at
  every location (Oakland shows 7–8 depending on the lead time), FLW-WC-35's newest batch failed its lab
  test (its packages are on hold everywhere), VAP-PE-1G's description carries a prompt injection.
- **clean**: like default without the two hazards. **failed-lab-test** / **prompt-injection**: one hazard each.
- **no-reorder-needed**: nothing is below its reorder point anywhere, for any lead time from 7 to 21 days.

History (`src/seed-year.ts`, `src/receivables.ts`; each from its own PRNG, so the core seed's ids and its
last 120 days of sales never move):

- **Sales, 12 months.** The last 120 days are the core seed (SO-1001 onwards); the 245 days before them
  (SO-<n> below 1001, oldest first) have mild seasonality: a holiday bump (late Nov–Dec), the 4/20 week, a
  January lull and a summer dip (Jun–Aug). They feed the 365-day half of the demand rate, so stock is
  calibrated after them and the at-risk sets above are unchanged.
- **Purchase orders.** 8–12 COMPLETED POs per vendor over the year (the core seed's three, PO-501…, plus
  older ones numbered below PO-501). Each vendor's most recent completed PO carries one price increase
  (HHF +4 %, ETG +5 %, SEC +8 %, GSE +6 %, CCV +7 %, MPR +5 %; that generation's batch cost and the open GSE
  PO follow). By default the older POs carry a few late receipts (lead time above the promised one;
  Sierra Extracts the worst, p90 ≈ 26 days vs 14) and short shipments, without changing any id.
  `MOCK_PO_VARIATION=0` (or `poVariation: false`, or `POST /__mock/reset {"po_variation": false}`) turns
  that off: every receipt on time and complete.
- **Accounts receivable.** One invoice per COMPLETED / DELIVERED order (`INV-1xxxx`, dated on the order
  date, due on the customer's Net 15 / Net 30 term), and payments that follow each customer's habits
  (ACH / check / cash). Harbor Greens is clearly the worst account (~$18.7k more than 60 days past due,
  partial payments on its 31–60 day invoices); Canopy Club Sacramento has two invoices 31–60 days late, The
  Herbal Cure one part-paid invoice, Sunset a few days late; Green Leaf and Elevate are current.

Stock is calibrated per location against each location's own sales (about half ship from Oakland, a
quarter each from Los Angeles and Sacramento), so a `location_ids`-filtered velocity report is as
realistic as the company-wide one.

Note on the velocity report: as in Distru, without `lead_time_days` no row has a reorder point, and a
`below_reorder_point` filter (`true` or `false`) then returns no rows. Omit the filter to get every row.

## REST

- **Endpoints:** inventory-velocity report, inventory, products, companies, locations, orders (with their `invoices`), purchases (upsert, plus `POST /purchases/{id}/pdf`), invoices (list with Distru's filters incl. `statuses`, `due_datetime`, `remaining_amount`, `total`; get; `POST /invoices/{id}/payments`, capped at the balance with the excess returned as an `overpayment_credits` entry), payments (list, get), payment methods (list, get), metrc packages, test results, batches, tasks (list, get, upsert, delete), users, custom fields (list, get, create; `custom_data` on purchases is validated, returned and filterable for dropdown/checkbox fields), deleted records, activity and record history. Activity and record history are fed by both REST writes (`PUBLIC_API`) and MCP writes (`MCP`).
- **List rate limit:** a token bucket of 3,000 calls refilling at 5 per minute. It applies to the paginated lists with an `updated_datetime` filter. A call whose `updated_datetime` lower bound is within the last 30 days is free and is never refused. `/activity` is free when it has no `changed_datetime`. Get-by-id, `/inventory`, reports and Metrc lists are unlimited. Responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`; a refused call gets a 429 with `Retry-After`.
- **PDF limit:** 20 successful PDFs per minute and 1,000 per day, as sliding windows.
- **Webhooks:** ORDER, PURCHASE, PRODUCT, PACKAGE, INVOICE (UPDATE when a payment is recorded).
  - PRODUCT fires when a company-wide active or reserved quantity changes. PACKAGE fires when a package is created or its quantity or status changes.
  - Deliveries for one record go out in order, one at a time. `object` is fetched when the webhook is sent.
  - Failed deliveries are retried about 10 times over about 4 hours (`MOCK_WEBHOOK_RETRY_DELAYS_MS` or `webhookRetryDelaysMs` to shorten).
- **Control plane:**
  - `GET /__mock/state` shows counts, activity, outbox, MCP telemetry, menus and buyer caps.
  - `GET` or `POST /__mock/config` changes:
    - `rate_limit`: `fail_next`, `every`, `retry_after`, plus `list.{enabled,capacity,refill_per_minute,free_window_days,tokens}` and `pdf.{per_minute,per_day}`;
    - `mcp_rate_limit`;
    - `webhook_url` and `webhook_retry_delays_ms`;
    - `metrc_fail_next` (the next N adjustments of a Metrc package save in Distru, then fail in Metrc);
    - `metrc_retry_failed: true` (one-shot: the failed Metrc activities are retried and sync).
  - `POST /__mock/reset` (`{ scenario?, now?, po_variation? }`) and `POST /__mock/simulate/order` (takes an optional `menu_id` and `placed_by: buyer|sales_rep`).

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
| get-me, search-products, get-product, report-inventory-valuation, report-inventory-assets, search-purchase-orders, get-purchase-order, search-companies, get-company, search-packages, get-package, search-test-results, search-sales-orders, get-sales-order, search-tasks, search-users, get-record-history, search-activity, search-metrc-activities, search-menus, get-menu-settings, search-menu-products, search-menu-collections | read | none |
| mutate-purchase-order (CREATE/UPDATE/DELETE) | write | quickbooks |
| adjust-inventory | write | biotrack, metrc |
| email-pdf (added to an outbox, never sent) | write | email |
| mutate-task, mutate-menu (CREATE/UPDATE; menus can't be deleted), mutate-product | write | none |

The per-buyer order cap is the product field `maxMenuBuyerOrderQuantity`, set with `distru-mutate-product`. On a menu order placed by a buyer it is enforced by `/__mock/simulate/order`; sales reps are exempt.

### Pointing a client at real Distru

Use the same client with `https://mcp.distru.com/mcp` and a real `distru_mcp_…` key (Distru → API settings; MCP has to be enabled for the account by a Distru rep). The connector-mcp preset reads `DISTRU_MCP_URL` and `DISTRU_MCP_KEY`, so set `DISTRU_MCP_URL=http://localhost:4500/mcp` to use the mock and unset it to use Distru. Things only the mock has: `/__mock/*`, the `metrc_fail_next` / `fail_next` / `latency_ms` toggles, and the outbox. Real Distru also offers OAuth ("Sign in with Distru") and linked accounts (a required `account` input), which the mock ignores.
