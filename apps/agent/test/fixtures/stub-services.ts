import type { ApiServices } from '../../src/api/services';

/** No-op services for route tests that don't exercise them. */
export const stubServices = (): Pick<ApiServices, 'runs' | 'connectors' | 'webhooks' | 'undo' | 'mcpTokens' | 'policyRules' | 'locations'> => ({
  runs: {
    list: async () => [],
    get: async () => null,
    start: async () => ({ runId: 'run-stub', workflowId: 'restock' }),
  },
  connectors: { list: async () => [] },
  webhooks: { distruSecret: 'test-secret', requestRestock: async () => {} },
  undo: {
    propose: async () => {
      throw new Error('undo not stubbed');
    },
  },
  mcpTokens: {
    create: async () => {
      throw new Error('mcpTokens not stubbed');
    },
    list: async () => [],
    revoke: async () => null,
    mcpUrl: 'http://localhost:4111/mcp',
  },
  policyRules: { list: async () => [], available: () => [], replace: async () => [] },
  locations: { list: async () => ({ items: [], fetchedAt: new Date(0).toISOString() }) },
});
