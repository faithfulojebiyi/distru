import type { ApiServices } from '../../src/api/services';

/** No-op services for route tests that don't exercise them. */
export const stubServices = (): Pick<ApiServices, 'runs' | 'connectors' | 'webhooks' | 'undo' | 'resume' | 'evals' | 'context' | 'mcpTokens' | 'policyRules' | 'locations'> => ({
  runs: {
    list: async () => [],
    get: async () => null,
    start: async () => ({ runId: 'run-stub', workflowId: 'restock' }),
  },
  connectors: { list: async () => [] },
  webhooks: { distruSecret: 'test-secret', emit: async () => {} },
  undo: {
    propose: async () => {
      throw new Error('undo not stubbed');
    },
  },
  evals: { latest: async () => [], history: async () => [] },
  context: {
    profile: async () => ({ available: false, version: null, computedAt: null, source: null, counts: null, vendors: [], products: [], sync: { lastRunAt: null, lastStatus: null, cursors: [] } }),
    memories: async () => [],
    onboarding: async () => {
      throw new Error('onboarding not stubbed');
    },
  },
  resume: {
    request: async () => {
      throw new Error('resume not stubbed');
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
