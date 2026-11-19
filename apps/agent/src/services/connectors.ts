import type { Registry } from '@ops/harness';
import type { ApiServices } from '../api/services';
import { DISTRU_MCP_ID, type McpStatus } from '../harness/registry';

/**
 * Connector catalogue + live health (each connector's `health` probe; a throwing probe reports not
 * ok). The Distru MCP bridge is listed even while it is not in the registry (server down at boot):
 * unhealthy, with the reason and the retry cadence, and no tools.
 */
export function createConnectorsService<TCtx>(registry: () => Registry<TCtx>, ctxFor: () => TCtx, mcpStatus?: () => McpStatus): ApiServices['connectors'] {
  return {
    async list() {
      const reg = registry();
      const health = new Map((await reg.health(ctxFor())).map((h) => [h.id, h]));
      const catalog = reg.catalog();
      const items = reg.connectors().map((c) => {
        const h = health.get(c.id);
        return {
          id: c.id,
          system: c.system,
          description: c.description,
          health: { ok: h?.ok ?? false, detail: h?.detail ?? null },
          readTools: c.readTools.length,
          actions: c.actions.length,
          tools: catalog
            .filter((d) => d.connector?.id === c.id)
            .map((d) => ({
              toolName: d.toolName,
              name: d.name,
              kind: d.kind,
              requiredScope: d.requiredScope,
              risk: d.kind === 'action' ? d.risk : null,
              description: d.description,
            })),
        };
      });
      const mcp = mcpStatus?.();
      if (mcp && mcp.state !== 'disabled' && !items.some((i) => i.id === DISTRU_MCP_ID)) {
        items.push({
          id: DISTRU_MCP_ID,
          system: 'erp',
          description: `Distru MCP server${mcp.url ? ` at ${mcp.url}` : ''} via the MCP bridge (not connected: its tools appear once tools/list succeeds).`,
          health: { ok: false, detail: mcp.detail },
          readTools: 0,
          actions: 0,
          tools: [],
        });
      }
      return items;
    },
  };
}
