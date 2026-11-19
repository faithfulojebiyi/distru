# @ops/headset-mock

A mock **retail analytics API in the style of Headset**: dispensary POS sell-through per product
per store. Distru integrates with Headset to "turn Headset sell-through data into reorders"; this
mock lets the agents do the same offline.

> **The API shape is our own.** Headset's API is partner-only and we have not seen its contract.
> Endpoints, field names and paging here are invented, loosely inspired by what Headset publicly
> describes. Do not treat them as Headset's real API.

```sh
bun run dev          # http://localhost:4600 (PORT), token HEADSET_MOCK_TOKEN (default headset-mock-token)
MOCK_SCENARIO=no-retail-signal MOCK_NOW=2026-11-19 bun run start
bun test && bun run typecheck
```

In-process: `createHeadsetMock({ now, scenario, token, pageSize })` returns `{ app, scenario, reset() }`;
call `app.request(url, init)` (no network), as `packages/connector-headset` tests do.

## Data

- **Products**: the same 43 SKUs / names as `apps/distru-mock/src/seed.ts` (replicated in
  `src/catalog.ts` because that seed does not export them; `test/catalog.test.ts` fails on drift).
- **Stores**: distru-mock's 6 dispensary customers + 4 extra market stores (`st_*` ids).
- **16 complete weeks** (Mon–Sun) before `now`, per SKU per store: `units`, `revenue`,
  `avg_retail_price`, `days_on_shelf`, `oos_days` (`days_on_shelf + oos_days = 7` while carried).
  Volumes mirror distru-mock's wholesale demand spread over its customers × store size.
- Fully deterministic: every value is a hash of (scenario, sku, store, week), so it never depends on
  request order. Weeks are anchored to `now`.

## Scenario trends (default)

Growth figures are on in-stock velocity (units per store shelf-day), last 3 weeks vs the 3 before.

| SKU | Story | What the data shows |
|---|---|---|
| `VAP-BD-1G` Blue Dream Live Resin Cart 1g | surging | ×1.30/×1.45/×1.60 over the last 3 weeks, all 10 stores: ≈ +52% |
| `PRE-BD-1G` Blue Dream Pre-Roll 1g | surging | same ramp, all 10 stores: ≈ +45% |
| `FLW-OGK-35` OG Kush 3.5g | **surging while Distru says fine** (not in distru-mock's 8 below-reorder SKUs, ~68 days of supply) | ×1.35/×1.55/×1.75: ≈ +52% |
| `EDB-CHO-MS` Milk Chocolate Sea Salt 100mg | declining (wholesale OK) | −6%/week from week 8: ≈ −25% |
| `EDB-GUM-WM` Watermelon Gummies 100mg | retail stock-outs rising (also below reorder in Distru) | OOS 1 day/store/week, then 2/3/4 over the last 3 weeks (30 → 90 store-days); velocity flat, raw units −34% |
| `FLW-TW-35` Trainwreck (Discontinued) | gone | off every shelf for the last 10 weeks (not carried, not OOS) |

Everything else is flat (|3-week growth| < 10%), with occasional single-day stock-outs.

## Endpoints

All `/v1/*` need `Authorization: Bearer <token>`. Lists use cursor paging: `?limit=` (1–200,
default 50) and `?cursor=` → `{ data, next_cursor, total }`. Array params accept `skus[]=a&skus[]=b`
or `skus=a,b`. Errors: `{ error: { code, message } }` (400/401/404).

| Endpoint | Returns |
|---|---|
| `GET /health` | `{ ok, scenario, latest_week }` (no auth) |
| `GET /v1/stores` | `{ id, name, city, state }` |
| `GET /v1/products?q=&skus[]=` | `{ sku, name, brand, category }` (name lookup) |
| `GET /v1/sell-through?skus[]=&store_ids[]=&weeks=` (1–16, default 8) | per SKU × store: `{ sku, product_name, store_id, store_name, weeks: [{ week_start, units, revenue, avg_retail_price, days_on_shelf, oos_days }] }` + `week_starts` |
| `GET /v1/trends?skus[]=&weeks=` | per SKU: `has_data`, `units_last_4w`, `units_prior_4w`, `wow_pct`, `growth_3w_pct` (velocity), `units_wow_pct`, `units_growth_3w_pct`, `stores_carrying`, `stores_carrying_4w_ago`, `oos_days_last_3w`, `oos_days_prior_3w`, `weekly[]` |
| `GET /v1/top-movers?window=7d\|28d&direction=up\|down\|both&limit=` (≤ 50) | `{ sku, product_name, units, prior_units, change_pct, direction, stores_carrying, oos_days }`, by \|change\| (ignores tiny volumes) |
| `POST /__mock/reset {scenario?, now?}` | reseed |
| `GET /__mock/scenarios` | scenario descriptions + `scenario_skus` |

## Scenarios

Names match distru-mock's where sensible so both mocks can be reset together.

| Scenario | Retail data |
|---|---|
| `default`, `clean`, `failed-lab-test`, `prompt-injection` | trends above |
| `no-reorder-needed` | flat demand everywhere |
| `no-retail-signal` | stores/products exist, no sell-through at all (`has_data: false`) |
