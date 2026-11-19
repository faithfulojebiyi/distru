import { defineConnector } from '@ops/harness';
import { purchasesUpsertAction } from './purchases-upsert';
import { tasksCreateAction } from './tasks-create';
import type { DistruCtx } from './shared';
import { inventoryTool, productsGetTool, productsSearchTool, vendorsTool } from './tools/catalog';
import { complianceCheckTool } from './tools/compliance';
import { openOrdersTool, vendorPurchaseHistoryTool } from './tools/orders';
import { DISTRU_RECEIVABLES_TOOLS } from './tools/receivables';
import { velocityReportTool } from './tools/velocity';
import { distruOrderCreatedTrigger } from './webhooks';

/**
 * Distru ERP connector. Registered names are `distru.<tool>` (tools `distru_velocity_report`, …)
 * and the actions `distru.purchases.upsert` (tool `propose_distru_purchases_upsert`) and
 * `distru.tasks.create` (tool `propose_distru_tasks_create`). Needs
 * `ctx.connectors.distru` (see `createDistruContext`).
 */
export const distruConnector = defineConnector<DistruCtx>({
  id: 'distru',
  system: 'erp',
  description: 'Distru cannabis ERP: inventory velocity, stock, products, vendors, purchase history, open orders, lab results / Metrc, overdue invoices / AR aging; proposes purchase orders and hand-off tasks.',
  readTools: [
    velocityReportTool,
    inventoryTool,
    productsGetTool,
    productsSearchTool,
    vendorsTool,
    vendorPurchaseHistoryTool,
    openOrdersTool,
    complianceCheckTool,
    // Accounts receivable: overdue balances by customer (aging buckets) and invoice search.
    ...DISTRU_RECEIVABLES_TOOLS,
  ],
  actions: [purchasesUpsertAction, tasksCreateAction],
  // Signed ORDER CREATE webhooks (POST /api/webhooks/distru) → restock-check the ordered products.
  triggers: [distruOrderCreatedTrigger],
  health: async (ctx) => {
    const page = await ctx.connectors.distru.listLocations({});
    const n = page.data?.length ?? 0;
    return { ok: true, detail: `${n} location${n === 1 ? '' : 's'} reachable` };
  },
});
