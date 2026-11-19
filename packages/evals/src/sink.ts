import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import postgres from 'postgres';
import type { EvalReport } from './report';
import type { ScenarioResult } from './runner';

/** Where eval results go. One report per batch; adapters decide the storage shape. */
export interface EvalResultSink {
  readonly name: string;
  write(report: EvalReport): Promise<void>;
  close?(): Promise<void>;
}

/** `reports/<batch>.json` + `reports/latest.json`. */
export class JsonFileSink implements EvalResultSink {
  readonly name = 'json';
  constructor(readonly dir: string) {}

  async write(report: EvalReport): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const body = `${JSON.stringify(report, null, 2)}\n`;
    writeFileSync(join(this.dir, `${report.batchId}.json`), body);
    writeFileSync(join(this.dir, 'latest.json'), body);
  }

  path(report: EvalReport): string {
    return join(this.dir, `${report.batchId}.json`);
  }
}

/** Keeps reports in memory (tests). */
export class MemorySink implements EvalResultSink {
  readonly name = 'memory';
  readonly reports: EvalReport[] = [];
  async write(report: EvalReport): Promise<void> {
    this.reports.push(report);
  }
}

/** One `eval_run` row as apps/agent's Drizzle schema defines it (apps/agent/src/db/schema.ts). */
export interface EvalRunRow {
  batch_id: string;
  scenario: string;
  scores: Record<string, number>;
  passed: boolean;
  details: Record<string, unknown>;
}

/**
 * Maps one scenario result to an `eval_run` row. Only scenarios that actually ran are stored
 * (pending / missing-recording ones would read as failures on the Evals page). The table has no
 * model / git sha / mode / cost columns, so those go in `details` (and cost/tokens in `scores`).
 */
export function toEvalRunRow(report: EvalReport, r: ScenarioResult): EvalRunRow | null {
  if (r.status !== 'pass' && r.status !== 'fail' && r.status !== 'error') return null;
  const graded = r.assertions.filter((a) => a.status !== 'skipped');
  const judge = r.assertions.find((a) => a.kind === 'llm_judge' && a.status !== 'skipped');
  const scores: Record<string, number> = {
    pass_rate: graded.length ? graded.filter((a) => a.status === 'pass').length / graded.length : 0,
    assertions_passed: r.passed,
    assertions_failed: r.failed,
    cost_usd: r.usage.costUsd,
    input_tokens: r.usage.inputTokens,
    output_tokens: r.usage.outputTokens,
    llm_calls: r.usage.llmCalls,
    latency_ms: r.latencyMs,
  };
  if (judge) scores.judge = judge.score;
  return {
    batch_id: report.batchId,
    scenario: r.id,
    scores,
    passed: r.status === 'pass',
    details: {
      title: r.title,
      status: r.status,
      reason: r.reason,
      mode: r.mode,
      model: r.model,
      gitSha: report.gitSha,
      judge: report.judge,
      assertions: r.assertions,
      usage: r.usage,
      realCalls: r.realCalls,
    },
  };
}

/**
 * Writes apps/agent's existing `eval_run` table (public schema; created by `bun run --cwd apps/agent
 * db:push`). Uses the `postgres` driver directly so evals don't depend on the app's DB module.
 */
export class PostgresEvalSink implements EvalResultSink {
  readonly name = 'postgres';
  readonly #sql: postgres.Sql;

  constructor(databaseUrl: string) {
    this.#sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
  }

  async write(report: EvalReport): Promise<void> {
    const rows = report.scenarios.map((r) => toEvalRunRow(report, r)).filter((r): r is EvalRunRow => r !== null);
    if (!rows.length) return;
    const sql = this.#sql;
    await sql.begin(async (tx) => {
      for (const row of rows) {
        await tx`
          insert into eval_run (batch_id, scenario, scores, passed, details)
          values (${row.batch_id}, ${row.scenario}, ${tx.json(row.scores)}, ${row.passed}, ${tx.json(JSON.parse(JSON.stringify(row.details)))})`;
      }
    });
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 5 });
  }
}

export function ensureDir(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
}
