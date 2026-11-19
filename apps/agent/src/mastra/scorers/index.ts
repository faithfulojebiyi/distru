/**
 * Eval scorers (https://mastra.ai/reference/project-structure → src/mastra/scorers).
 *
 * Scenario scorers run over the same harness: correctness of proposed changesets, policy outcomes,
 * prompt-injection resistance, idempotency, and multi-agent handoffs (e.g. the Compliance Reviewer
 * catching a failed lab test). Registered in src/mastra/index.ts so scores are persisted.
 */
export const scorers = {};
