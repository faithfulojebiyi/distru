/**
 * drizzle-kit settings the app merges into its own `drizzle.config.ts` (this package does not run
 * drizzle-kit itself). Paths are relative to `apps/agent`.
 *
 * ```ts
 * // apps/agent/drizzle.config.ts
 * export default defineConfig({
 *   dialect: 'postgresql',
 *   schema: ['./src/db/schema.ts', ...contextDrizzleConfig.schema],
 *   schemaFilter: ['public', ...contextDrizzleConfig.schemaFilter],
 *   out: './drizzle',
 *   dbCredentials: { url: process.env.DATABASE_URL! },
 * });
 * ```
 */
export const contextDrizzleConfig = {
  schema: ['../../packages/context/src/drizzle/schema.ts'],
  schemaFilter: ['context'],
} as const;
