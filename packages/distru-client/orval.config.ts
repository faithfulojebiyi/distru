import { defineConfig } from 'orval';

export default defineConfig({
  distru: {
    input: { target: './openapi.filtered.json' },
    output: {
      mode: 'split',
      client: 'fetch',
      target: './src/generated/distru.ts',
      schemas: './src/generated/model',
      clean: true,
      override: {
        mutator: { path: './src/mutator.ts', name: 'distruFetch' },
        fetch: { includeHttpResponseReturnType: false },
      },
    },
  },
});
