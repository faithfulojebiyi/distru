import type { ApiServices } from '../../src/api/services';

/** No-op runs/connectors/webhooks services for route tests that don't exercise them. */
export const stubServices = (): Pick<ApiServices, 'runs' | 'connectors' | 'webhooks'> => ({
  runs: {
    list: async () => [],
    get: async () => null,
    start: async () => ({ runId: 'run-stub', workflowId: 'restock' }),
  },
  connectors: { list: async () => [] },
  webhooks: { distruSecret: 'test-secret', requestRestock: async () => {} },
});
