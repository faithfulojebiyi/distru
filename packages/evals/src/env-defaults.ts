/**
 * Imported first by every entry point (and preloaded by `bun test`). The agent's modules parse
 * `apps/agent/src/env.ts` at import time, which requires DATABASE_URL and BETTER_AUTH_SECRET.
 * Evals never touch that database through those modules (the in-process harness is in-memory), so
 * placeholders are set when the variables are missing. Real values (e.g. for the Postgres sink)
 * win. DISTRU_MCP_URL is cleared so the app's module-level connector singleton stays inert.
 */
process.env.DATABASE_URL ??= 'postgres://evals:evals@127.0.0.1:1/evals-placeholder';
process.env.BETTER_AUTH_SECRET ??= 'evals-placeholder-secret-000000000000000000';
process.env.DISTRU_MCP_URL ??= '';
export {};
