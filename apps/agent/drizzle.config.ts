import { contextDrizzleConfig } from '@ops/context/drizzle';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  // App tables (`public`) + the context layer (`context` schema, packages/context).
  schema: ['./src/db/schema.ts', ...contextDrizzleConfig.schema],
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://ops:ops@127.0.0.1:5482/ops' },
  // Mastra owns the `mastra` schema; drizzle-kit manages `public` and `context`.
  schemaFilter: ['public', ...contextDrizzleConfig.schemaFilter],
  strict: false,
  verbose: true,
});
