import { defineConnector } from '@ops/harness';
import { purchasesUpsertAction } from './purchases-upsert';
import type { DistruCtx } from './shared';
import { inventoryTool, productsGetTool, productsSearchTool, vendorsTool } from './tools/catalog';
import { complianceCheckTool } from './tools/compliance';
import { openOrdersTool, vendorPurchaseHistoryTool } from './tools/orders';
import { velocityReportTool } from './tools/velocity';

/**
 * Distru ERP connector. Registered names are `distru.<tool>` (tools `distru_velocity_report`, …)
 * and `distru.purchases.upsert` (tool `propose_distru_purchases_upsert`). Needs
 * `ctx.connectors.distru` (see `createDistruContext`).
 */
export const distruConnector = defineConnector<DistruCtx>({
  id: 'distru',
  system: 'erp',
  description: 'Distru cannabis ERP: inventory velocity, stock, products, vendors, purchase history, open orders, lab results / Metrc; proposes purchase orders.',
  readTools: [
    velocityReportTool,
    inventoryTool,
    productsGetTool,
    productsSearchTool,
    vendorsTool,
    vendorPurchaseHistoryTool,
    openOrdersTool,
    complianceCheckTool,
  ],
  actions: [purchasesUpsertAction],
  health: async (ctx) => {
    const page = await ctx.connectors.distru.listLocations({});
    const n = page.data?.length ?? 0;
    return { ok: true, detail: `${n} location${n === 1 ? '' : 's'} reachable` };
  },
});
