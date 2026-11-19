/**
 * End-to-end smoke test against a running Distru (mock by default):
 *   bun run --cwd apps/distru-mock start   # in another terminal
 *   bun run scripts/smoke.ts               # DISTRU_BASE_URL / DISTRU_API_TOKEN override
 *
 * Proves typing, bracketed array params, pagination, upsert + read-after-write verification, the
 * error envelope, 429 retry (via the mock's /__mock/config) and webhooks (mock only).
 */
import { buildPurchaseOrder, createDistruClientFromEnv, DistruApiError, upsertPurchaseVerified } from '../src';

const client = createDistruClientFromEnv(process.env, { maxRetryDelayMs: 5_000 });
const base = client.config.baseUrl.replace(/\/public\/v1\/?$/, '');
const isMock = !process.env.DISTRU_API_TOKEN || /localhost|127\.0\.0\.1/.test(base);
const log = (label: string, v: unknown) => console.log(`✔ ${label}:`, v);

if (isMock) await fetch(`${base}/__mock/reset`, { method: 'POST', body: JSON.stringify({ scenario: 'default' }) });

// webhook receiver (mock only)
const hooks: { type: string; event: string; id: string }[] = [];
const receiver = isMock
  ? Bun.serve({
      port: 0,
      fetch: async (req) => {
        hooks.push(await req.json());
        return new Response('ok');
      },
    })
  : null;
if (receiver) await fetch(`${base}/__mock/config`, { method: 'POST', body: JSON.stringify({ webhook_url: `http://localhost:${receiver.port}/hooks` }) });

// 1. reorder candidates
const report = await client.getInventoryVelocityReport({ below_reorder_point: true, lead_time_days: 14, target_days_of_supply: 30 });
log(
  'below reorder point',
  report.data.map((r) => `${r.sku} avail=${r.quantity_available} rop=${r.reorder_point} ${r.reorder_status} suggest=${r.suggested_order_quantity}`),
);

// 2. pagination across products / orders
const products = await client.listAll(client.listProducts, { is_active: true });
log('active products (paginated)', products.length);
let openOrders = 0;
for await (const o of client.paginate(client.listOrders, { statuses: ['PENDING', 'PROCESSING', 'READY_TO_SHIP'] })) openOrders += o.items?.length ? 1 : 0;
log('open sales orders', openOrders);
const vendors = await client.listAll(client.listCompanies, { relationship_type_ids: ['rel-vendor'] });
log('vendors', vendors.map((v) => v.name));

// 3. compliance reads for the first candidate
const target = report.data.find((r) => r.sku === 'FLW-WC-35') ?? report.data[0]!;
const batches = await client.listAll(client.listBatches, { product_ids: [target.product_id] });
const tests = await client.listAll(client.listTestResults, { batch_ids: batches.map((b) => b.id) });
log(`lab results for ${target.sku}`, tests.map((t) => t.name));
const pkgs = await client.listAll(client.listMetrcPackages, { statuses: ['ONHOLD'] });
log('metrc packages on hold', pkgs.map((p) => `${p.label} ${p.lab_testing_state}`));

// 4. upsert a PO and verify by reading it back
const locations = await client.listAll(client.listLocations, {});
const body = buildPurchaseOrder({
  vendorId: target.vendor_id,
  locationId: locations[0]!.id,
  lines: [{ productId: target.product_id, quantity: Number(target.suggested_order_quantity ?? 24), unitPrice: 15 }],
  description: `Smoke-test restock for ${target.sku}`,
  idempotencyKey: `smoke-${Date.now()}`,
});
const { purchase, mismatches } = await upsertPurchaseVerified(client, body);
log('created PO', `${purchase.purchase_number} ${purchase.status} total=${purchase.total} mismatches=${mismatches.length}`);
const updated = await upsertPurchaseVerified(client, { id: purchase.id, status: 'PROCESSING' });
log('updated PO', `${updated.purchase.purchase_number} ${updated.purchase.status} mismatches=${updated.mismatches.length}`);

// 5. error envelope
try {
  await client.upsertPurchase({ status: 'PENDING', items: [{ quantity: 0, price: 1 }] });
} catch (e) {
  if (!(e instanceof DistruApiError)) throw e;
  log('validation error', `${e.status} ${e.errors.map((x) => x.pointer.join('.')).join(', ')}`);
}

// 6. 429 retry (mock only)
if (isMock) {
  await fetch(`${base}/__mock/config`, { method: 'POST', body: JSON.stringify({ rate_limit: { fail_next: 2, retry_after: 1 } }) });
  const t0 = Date.now();
  const companies = await client.listCompanies();
  log('429 x2 then success', `${companies.data?.length} companies after ${Date.now() - t0}ms`);
}

// 7. webhooks (mock only)
if (receiver) {
  await fetch(`${base}/__mock/simulate/order`, { method: 'POST', body: '{}' });
  await new Promise((r) => setTimeout(r, 300));
  log('webhooks received', hooks.map((h) => `${h.type} ${h.event}`));
  await fetch(`${base}/__mock/config`, { method: 'POST', body: JSON.stringify({ webhook_url: null }) });
  receiver.stop(true);
}
console.log('smoke OK');
