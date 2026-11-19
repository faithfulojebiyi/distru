import { defineConfig } from 'orval';

/**
 * Plain request functions generated from the agent server's OpenAPI document,
 * one file per tag. TanStack Query hooks are written by hand per feature
 * (see src/modules/session/session-api.ts) so query keys, toasts and
 * invalidation stay in one readable place.
 *
 * Start the agent server first (bun run dev:agent), or point OPENAPI_INPUT at
 * a file: OPENAPI_INPUT=./openapi.placeholder.json bun run api:generate
 */
const apiUrl = process.env.VITE_API_URL ?? 'http://localhost:4111';

export default defineConfig({
  agent: {
    input: { target: process.env.OPENAPI_INPUT ?? `${apiUrl}/api/openapi.json` },
    output: {
      client: 'fetch',
      mode: 'tags-split',
      clean: true,
      target: './src/api/generated',
      /** every request goes through the mutator: agent origin + session cookie + ApiError */
      override: {
        mutator: { name: 'apiFetch', path: './src/api/client.ts' },
        /** functions resolve to the parsed body, like carbonme's axios functions; errors throw ApiError */
        fetch: { includeHttpResponseReturnType: false },
      },
    },
  },
});
