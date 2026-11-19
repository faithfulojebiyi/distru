/**
 * Mastra tools (https://mastra.ai/reference/project-structure → src/mastra/tools).
 *
 * Tools here are generated from the harness registry (`registry.catalog(principal)`): read tools
 * (`inventory_search`, …) call `registry.runReadTool`, write tools are only ever `propose_*` and call
 * `harness.propose` — agents never write to Distru directly. Each agent gets the subset its
 * principal's scopes allow. Registered globally in src/mastra/index.ts.
 */
export const tools = {};
