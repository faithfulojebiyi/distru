# @ops/connector-distru

The Distru ERP connector for `@ops/harness`, built on `@ops/distru-client`.

```ts
import { Registry, createHarness } from '@ops/harness';
import { distruConnector, createDistruContext, distruErrorClassifier } from '@ops/connector-distru';

const registry = Registry.fromConnectors([distruConnector]);            // Registry<DistruCtx>
const ctx = { ...createDistruContext({ baseUrl: env.DISTRU_BASE_URL, token: env.DISTRU_API_TOKEN, maxRetries: 0 }) };
const harness = createHarness({ registry, store, audit, policyRules, errors: distruErrorClassifier, steps });
```

`ctx.connectors.distru` is a `DistruClient`. `maxRetries: 0` lets 429s reach the harness, which
retries with `Retry-After` and audits each retry (`op.retry`); keep the client default for reads
outside the harness if you prefer.

## Tools

All registered as `distru.<name>` (agent tool name `distru_<name>`). Outputs are trimmed for LLMs:
numbers parsed from Distru's decimal strings, ISO dates, ids the agent needs, no raw API dumps.

| Tool | Input | Output |
|---|---|---|
| `velocity_report` | `below_reorder_point`=true, `lead_time_days`, `target_days_of_supply`, `service_level`, `vendor_ids`, `location_ids` (per-location rows), `product_ids`, `search`, `limit` | rows: product id/sku/name, vendor, location, on_hand_available, incoming, avg_daily_demand, days_of_supply(+incoming), reorder_point, reorder_status, suggested_qty, units_per_case, stockout/reorder-by dates |
| `inventory` | `product_ids`, `skus`, `location_ids`, `by_location`=true | rows: product id/sku/name, location, active/reserved/available |
| `products_get` | `product_id` or `sku` | product detail + `description` as untrusted text |
| `products_search` | `query`, `skus`, `vendor_ids`, `is_active`=true | compact products (no free text) |
| `vendors` | `name`, `vendor_ids` | vendor id/name/licenses/PO email + `lead_time_days` (custom field, else median order→receipt of completed POs) |
| `vendor_purchase_history` | `vendor_id`, `product_ids`, `statuses`, `limit` | recent POs (lines with unit prices, statuses) + per-product price summary |
| `open_orders` | `product_ids`, `location_ids`, `statuses`, `limit` | open sales orders with lines + `demand_by_product` |
| `compliance_check` | `product_ids`, `batches_per_product`=3 | per product `{ status: ok \| blocked \| unknown, reasons[], batches[] }` |

Action `purchases.upsert` (tool `propose_distru_purchases_upsert`, risk `medium`, scope `propose`):
`{ vendor_id, location_id, lines: [{ product_id, quantity, unit_price }], expected_delivery_date?, notes?, purchase_id? }`.
The payload is the exact `POST /purchases` body (`buildPurchaseOrder`, status PENDING; or
`buildPurchaseUpdate` with the full line set, keeping existing line ids). The idempotency key is
stamped into the PO description as `[ops-agent:idem=<key>]` at execute time and looked up with
`findPurchaseByIdempotencyKey` before every attempt; verify reads the PO back and runs
`matchesExpected`. Updates are refused for POs not in DRAFT/PENDING/PROCESSING, for another vendor
or another receiving location. `expected_delivery_date` goes into the notes (Distru purchases have
no delivery-date field).

`purchases.upsert` exports `{ purchase_number, status }` (harness `outputs`), so later ops in the same
proposal can reference `{{op:N.purchase_number}}` / `{{op:N.recordId}}`.

Action `tasks.create` (tool `propose_distru_tasks_create`, risk `low`, `moneyless`): the human hand-off,
e.g. "Receive PO-1042 on 2026-12-03" linked to the PO and assigned to the purchasing user.
`{ name, due (date → 17:00 UTC, or datetime), description?, owner_id? | owner_role?, purchase_id?, location_id? }`.
`owner_role` is resolved at plan time through `GET /users` (first active user with that role name), so
the payload is the exact `POST /tasks` body (`status: ACTIVE`). `purchase_id`/`name` may hold op
references, resolved by the harness from the PO op. The key is stamped into the description and found
by listing tasks updated in the free 30-day window; verify reads the task back (name, status, owner,
linked purchase, description, due instant). `location_id` must be one of a *company's* locations
(Distru refuses your own). Exports `{ task_name, owner_id }`.

## Undo (harness `compensate`)

- `purchases.upsert`: Distru purchases have no cancelled status, so undoing a **created** PO is
  `DELETE /purchases/{id}` (hard delete: lines, charges, payments and linked tasks go too; QuickBooks
  bill deleted by Distru's sync), only while the PO never touched inventory (DRAFT, PENDING, PROCESSING,
  DELIVERING); a received PO is refused ("handle it in Distru"). Undoing an **update** restores the
  `before` line set and notes while the PO is editable (current line ids kept, idempotency markers on
  the PO preserved). A 404 on delete counts as already undone.
- `tasks.create`: `DELETE /tasks/{id}` (404 = already gone, e.g. deleted with its PO).
- `@ops/distru-client` exposes `deletePurchase` (added to the filtered spec; the mock implements
  `DELETE /public/v1/purchases/:id` with Distru's refusal rules).

## Compliance derivation

Distru has no pass/fail field. A test result fails when its title contains FAILED or an analyte in
`additional_test_results` exceeds `ACTION_LEVELS` (screening thresholds, microbials fail when
detected); a Metrc package is a problem when ONHOLD, `lab_testing_state` contains "Fail", or it
requires remediation. Blocked = failed test on the newest batch or any held/failed package;
unknown = no batches or no verdict on the newest batch; failures on older batches are warnings.

## Trigger: `distru.order_created`

`distruOrderCreatedTrigger` (registered on the connector, harness `defineTrigger`) verifies Distru's
`x-distru-signature: sha256=<hex HMAC-SHA256 of the raw body>` (secret `DISTRU_WEBHOOK_SECRET`,
constant-time), and normalizes an ORDER CREATE envelope into
`{ source: 'distru', eventId, orderId, productIds, locationIds }` (event `distru/order.created`; dedupe id
`distru.order_created:ORDER:CREATE:<order id>`). Other events are acknowledged and ignored; a bad
signature is a 401 `invalid_signature`, a non-JSON / non-envelope body a 400 `invalid_body`. Also
exported: `signDistruBody`, `verifyDistruSignature`, `DistruWebhookSchema`, `restockScopeFor`. Apps run
it with `ingestWebhook` (apps/agent: POST /api/webhooks/distru).

## Untrusted ERP text

Free text in Distru (descriptions, notes, lab titles) is data, never instructions:

- Omitted where not needed: order notes, Metrc package notes, company notes, product descriptions
  outside `products_get`.
- Otherwise wrapped as `{ untrusted_text, source, suspicious }`. `suspicious` flags instruction-like
  text (possible prompt injection) for evals, the UI and the Policy Critic. Names and SKUs pass
  through as identifiers, but on a single line and capped in length.
- Harness decisions (compliance status, policy) never act on free text.

Tests check that the seeded injection on VAP-PE-1G only ever appears inside `untrusted_text` with
`suspicious: true`.

```sh
bun test        # unit tests + integration tests against the in-process mock
bun run typecheck
```
