# @ops/connector-headset

Retail sell-through connector for `@ops/harness` (system `analytics`), talking to
`apps/headset-mock`, a mock of Headset whose **API shape is our own** (Headset's real API is
partner-only). **Read tools only: no actions**, so it can never propose a write.

```ts
import { Registry } from '@ops/harness';
import { distruConnector, createDistruContextFromEnv } from '@ops/connector-distru';
import { headsetConnector, createHeadsetContextFromEnv } from '@ops/connector-headset';

const registry = Registry.fromConnectors([distruConnector, headsetConnector]);
const ctx = { connectors: { ...createDistruContextFromEnv().connectors, ...createHeadsetContextFromEnv().connectors } };
```

Env: `HEADSET_BASE_URL` (default `http://localhost:4600`), `HEADSET_API_TOKEN` (default the mock's
`headset-mock-token`). Health probe: one page of `/v1/stores` → `"10 stores reachable"`.

## Tools

Registered as `headset.<name>` (agent tool `headset_<name>`), scope `read`.

| Tool | Input | Output |
|---|---|---|
| `retail_trends` | `skus[]` and/or `product_names[]` (≤ 50; exact or unique partial name) | `latest_week`, rows `{ sku, product_name, units_last_4w, wow_pct, growth_3w_pct, stores_carrying, oos_days_last_3w, oos_days_prior_3w, oos_trend, signal }`, `unmatched[]` |
| `retail_sell_through` | `skus`/`product_names` (≤ 10), `store_ids?`, `weeks`=6, `max_stores`=10 | `week_starts[]` + rows `{ sku, store_id, store, units[], oos_days[] }` (top stores by units), `truncated`, `unmatched` |
| `top_movers` | `window` 7d\|28d (=28d), `direction` up\|down\|both, `limit`=10 | rows `{ sku, product_name, change_pct, units, prior_units, direction, stores_carrying, oos_days }` |
| `demand_signal` | `sku` or `product_name`, `wholesale_days_of_supply` (nullable), `wholesale_avg_daily` (from `distru_velocity_report`), `lead_time_days`=14, `safety_days`=7 | `retail { signal, growth_3w_pct, wow_pct, oos_trend, stores_carrying }`, `wholesale`, `adjusted_days_of_supply`, `adjusted_avg_daily`, `demand_factor`, `recommendation`, `reasons[]` |

Growth is on **in-stock velocity** (units per store shelf-day) so empty shelves don't read as falling
demand. `signal`: `surging` ≥ +30%, `rising` ≥ +10%, `declining` ≤ −10%, else `flat`; `no_data` when
there is no retail data or < 8 units in 4 weeks. `oos_trend` compares store-days out of stock, last
3 weeks vs the 3 before; a change must be ≥ max(3, stores carrying, 50% of the smaller window).

Outputs carry identifiers and numbers only. Store and product names are flattened to one line and
capped (60/80 chars); there is no free text from Headset, so nothing needs untrusted wrapping.

## Demand blend: maths in code, not in the prompt

`blendDemandSignal({ wholesaleDaysOfSupply, wholesaleAvgDaily, retailGrowth3w, retailOosTrend, leadTimeDays?, safetyDays? })`
is a pure function (`src/signal.ts`); the Inventory Analyst calls it through `demand_signal` instead
of doing arithmetic in its head.

```
g        = retail 3-week growth %, clamped to [-50, +150]; 0 if |g| < 10 (noise) or no signal;
           declines count half (under-ordering into a stock-out costs more than extra stock)
factor   = (1 + g/100) × 1.15 if retail stock-outs are rising (empty shelves hide demand)
adjusted = wholesaleDaysOfSupply ÷ factor          adjustedAvgDaily = wholesaleAvgDaily × factor
cover    = leadTimeDays + safetyDays (14 + 7)

reorder_now  wholesale DoS ≤ lead time, or adjusted ≤ cover
watch        adjusted ≤ 2 × cover, or retail surging (g ≥ 30), or stock-outs rising
ok           otherwise
```

So a SKU Distru calls healthy but that is surging at retail (`FLW-OGK-35`: ~68 days → ~45 adjusted)
comes back `watch` with a reason, never `ok`; one near its reorder point tips into `reorder_now`.
No wholesale velocity → `adjusted: null`, `watch` only if retail is surging or stocking out.

## Tests

```sh
bun test        # blend + classifier unit tests; connector tests against the in-process mock
bun run typecheck
```

Covers: surging SKUs (by SKU and name), the "Distru says OK" SKU flagged (wholesale numbers taken
live from `connector-distru` over `distru-mock`), declining, OOS-rising, `no-retail-signal`
fallback, top movers, sell-through trimming, read-only scope (no actions, `read` required), health,
and hostile store names being flattened.
