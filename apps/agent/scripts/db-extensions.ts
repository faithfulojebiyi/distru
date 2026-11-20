/**
 * Postgres extensions the app needs, before `drizzle-kit push` (`db:push`) and the seed: `vector`
 * (pgvector) for semantic recall (PgVector, schema `recall`) and the Copilot's Mastra semanticRecall.
 * Requires the pgvector image (docker-compose.yml: pgvector/pgvector:pg16-trixie). Idempotent.
 */
import postgres from 'postgres';

const url = process.env.DATABASE_URL ?? 'postgres://ops:ops@127.0.0.1:5482/ops';
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  await sql`create extension if not exists vector`;
  const [row] = await sql<{ extversion: string }[]>`select extversion from pg_extension where extname = 'vector'`;
  console.log(`pgvector ${row?.extversion ?? '?'} enabled on ${new URL(url).pathname.slice(1)}`);
} catch (err) {
  console.error(`could not enable pgvector (${err instanceof Error ? err.message : String(err)}). Is Postgres running the pgvector image? See README "Postgres + pgvector".`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 2 });
}
