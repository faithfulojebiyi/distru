/**
 * bun test preload (bunfig.toml): tests never touch the dev database.
 *
 * - `DATABASE_URL` is replaced by `TEST_DATABASE_URL`, default: the dev URL with the database renamed to
 *   `ops_test` (same server). Bun loads `.env` before the preload, so this runs before `src/env.ts` or
 *   `src/db/client.ts` read it.
 * - The test database is created when missing and its schema (`public` app tables + the `context`
 *   schema) is generated from the Drizzle schema files with drizzle-kit's API. A hash of those files is
 *   stored in `public.__test_schema`; when the schema changes the test database is dropped and rebuilt
 *   (it only ever holds throwaway test data), so no interactive rename prompts can block a run.
 * - If Postgres is unreachable this only warns: the Postgres integration tests skip themselves.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const DEFAULT_DEV_URL = 'postgres://ops:ops@127.0.0.1:5482/ops';

export function testDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  if (env.TEST_DATABASE_URL) return env.TEST_DATABASE_URL;
  const url = new URL(env.DATABASE_URL ?? DEFAULT_DEV_URL);
  url.pathname = '/ops_test';
  return url.toString();
}

const devUrl = process.env.DATABASE_URL ?? DEFAULT_DEV_URL;
const testUrl = testDatabaseUrl();
if (new URL(testUrl).pathname === new URL(devUrl).pathname && new URL(testUrl).host === new URL(devUrl).host && !process.env.TEST_DATABASE_URL) {
  throw new Error('test preload: refusing to run tests against the dev database');
}
process.env.DATABASE_URL = testUrl;
process.env.TEST_DATABASE_URL = testUrl;
// A dev .env may point at a local collector; tests never export traces.
delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

const SCHEMA_FILES = ['../src/db/schema.ts', '../../../packages/context/src/drizzle/schema.ts'].map((p) => fileURLToPath(new URL(p, import.meta.url)));

async function ensureTestDatabase(): Promise<void> {
  const hash = createHash('sha256')
    .update(SCHEMA_FILES.map((f) => readFileSync(f, 'utf8')).join('\n'))
    .digest('hex')
    .slice(0, 16);
  const dbName = decodeURIComponent(new URL(testUrl).pathname.slice(1));
  if (!/^[a-z0-9_]+$/i.test(dbName)) throw new Error(`test preload: unexpected test database name '${dbName}'`);

  const probe = postgres(testUrl, { max: 1, connect_timeout: 2, onnotice: () => {} });
  try {
    const [row] = await probe<{ hash: string }[]>`select hash from public.__test_schema limit 1`;
    if (row?.hash === hash) return; // up to date
  } catch {
    /* missing database, table or server: handled below */
  } finally {
    await probe.end({ timeout: 1 }).catch(() => {});
  }

  const adminUrl = new URL(testUrl);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1, connect_timeout: 2, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin.unsafe(`create database ${dbName}`);
  } finally {
    await admin.end({ timeout: 1 }).catch(() => {});
  }

  const { generateDrizzleJson, generateMigration } = await import('drizzle-kit/api');
  const appSchema = await import('../src/db/schema');
  const { contextTables } = await import('@ops/context/drizzle');
  const empty = generateDrizzleJson({});
  const statements = await generateMigration(empty, generateDrizzleJson({ ...appSchema, ...contextTables }, empty.id, ['public', 'context']));
  const sql = postgres(testUrl, { max: 1, onnotice: () => {} });
  try {
    // pgvector (semantic recall); best effort so a plain postgres image still runs the other tests.
    await sql.unsafe('create extension if not exists vector').catch((err: unknown) => console.warn(`[test preload] pgvector unavailable: ${err instanceof Error ? err.message : String(err)}`));
    for (const s of statements) await sql.unsafe(s);
    await sql.unsafe('create table public.__test_schema (hash text not null)');
    await sql`insert into public.__test_schema (hash) values (${hash})`;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
  console.log(`[test preload] rebuilt test database ${dbName} (${statements.length} statements)`);
}

try {
  await ensureTestDatabase();
} catch (err) {
  console.warn(`[test preload] test database unavailable (${err instanceof Error ? err.message : String(err)}); Postgres tests will skip`);
}
