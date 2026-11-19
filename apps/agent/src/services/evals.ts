import { desc, eq, sql } from 'drizzle-orm';
import type { EvalResult } from '../api/schemas-insight';
import type { DB } from '../db/client';
import { evalRun } from '../db/schema';

type Row = typeof evalRun.$inferSelect;
const toResult = (r: Row): EvalResult => ({ id: r.id, batchId: r.batchId, scenario: r.scenario, passed: r.passed, scores: r.scores, details: r.details ?? null, createdAt: r.createdAt.toISOString() });

/** `eval_run` rows written by `@ops/evals --sink pg`: latest per scenario, and one scenario's history. */
export function createEvalsService(db: DB) {
  return {
    async latest(): Promise<EvalResult[]> {
      const rows = await db
        .selectDistinctOn([evalRun.scenario])
        .from(evalRun)
        .orderBy(evalRun.scenario, desc(evalRun.createdAt), desc(sql`${evalRun.id}`));
      return rows.map(toResult);
    },
    async history(scenario: string, limit: number): Promise<EvalResult[]> {
      const rows = await db.select().from(evalRun).where(eq(evalRun.scenario, scenario)).orderBy(desc(evalRun.createdAt)).limit(limit);
      return rows.map(toResult);
    },
  };
}
