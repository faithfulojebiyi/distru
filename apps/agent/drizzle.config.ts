import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://ops:ops@127.0.0.1:5482/ops' },
  // Mastra owns the `mastra` schema; drizzle-kit only manages `public`.
  schemaFilter: ['public'],
  strict: false,
  verbose: true,
});
