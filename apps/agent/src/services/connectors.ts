import type { Registry } from '@ops/harness';
import type { ApiServices } from '../api/services';

/** Connector catalogue + live health (each connector's `health` probe; a throwing probe reports not ok). */
export function createConnectorsService<TCtx>(registry: Registry<TCtx>, ctxFor: () => TCtx): ApiServices['connectors'] {
  return {
    async list() {
      const health = new Map((await registry.health(ctxFor())).map((h) => [h.id, h]));
      const catalog = registry.catalog();
      return registry.connectors().map((c) => {
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
    },
  };
}
