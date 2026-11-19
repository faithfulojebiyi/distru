import { defineConnector } from '@ops/harness';
import type { HeadsetCtx } from './shared';
import { demandSignalTool, retailSellThroughTool, retailTrendsTool, topMoversTool } from './tools';

/**
 * Headset-style retail analytics connector (system `analytics`). READ TOOLS ONLY: no actions, so it
 * can never propose a write. Registered as `headset.<tool>` (agent tools `headset_retail_trends`, …).
 * Needs `ctx.connectors.headset` (see `createHeadsetContext`).
 */
export const headsetConnector = defineConnector<HeadsetCtx>({
  id: 'headset',
  system: 'analytics',
  description: 'Retail sell-through analytics across dispensaries (mock of Headset): per-SKU trends, per-store weekly series, top movers, and a wholesale × retail demand blend. Read-only.',
  readTools: [retailTrendsTool, retailSellThroughTool, topMoversTool, demandSignalTool],
  actions: [],
  health: async (ctx) => {
    const { stores } = await ctx.connectors.headset.probe();
    return { ok: true, detail: `${stores} store${stores === 1 ? '' : 's'} reachable` };
  },
});
