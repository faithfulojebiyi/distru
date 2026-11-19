import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { getEvalHistory, listEvals } from '../../api/generated/evals/evals';
import type { EvalResult } from '../../api/generated/opsAgentAPI.schemas';
import { getQueryScope } from '../../lib/query';

export type EvalRun = EvalResult;

export const evalKeys = {
  all: (scope: string) => ['evals', scope] as const,
  list: (scope: string) => ['evals', scope, 'list'] as const,
  history: (scope: string, scenario: string) => ['evals', scope, 'history', scenario] as const,
};

/** The latest `eval_run` row per scenario (`GET /api/evals`). A 404 means an older server without the route. */
export const useEvalRuns = () => {
  const client = useQueryClient();
  return useQuery({
    queryKey: evalKeys.list(getQueryScope(client)),
    queryFn: ({ signal }) => listEvals({ signal }),
    select: (data) => [...data.items].sort((a, b) => a.scenario.localeCompare(b.scenario)),
    meta: { suppressErrorToast: true },
  });
};

/** One scenario's runs, newest first (`GET /api/evals/:scenario/history`), for the history drawer. */
export const useEvalHistory = (scenario: string | null) => {
  const client = useQueryClient();
  return useQuery({
    queryKey: evalKeys.history(getQueryScope(client), scenario ?? ''),
    queryFn: ({ signal }) => getEvalHistory(scenario ?? '', { limit: 100 }, { signal }),
    select: (data) => data.items,
    enabled: scenario !== null,
    meta: { suppressErrorToast: true },
  });
};

/** `details` is free-form JSON (packages/evals/src/sink.ts toEvalRunRow): title, status, reason, mode, model, gitSha. */
const DetailsSchema = z.looseObject({
  title: z.string().optional(),
  status: z.string().optional(),
  reason: z.string().nullable().optional(),
  mode: z.string().optional(),
  model: z.string().optional(),
  gitSha: z.string().nullable().optional(),
});

/** The figures a row shows, read from scores / details (missing ones are null). */
export const evalFacts = (run: EvalRun) => {
  const parsed = DetailsSchema.safeParse(run.details ?? {});
  const details = parsed.success ? parsed.data : {};
  const s = run.scores;
  const passed = s.assertions_passed ?? null;
  const failed = s.assertions_failed ?? null;
  return {
    title: details.title ?? run.scenario,
    status: details.status ?? (run.passed ? 'pass' : 'fail'),
    reason: details.reason ?? null,
    model: details.model ?? null,
    mode: details.mode ?? null,
    gitSha: details.gitSha ?? null,
    assertions: passed !== null ? { passed, total: passed + (failed ?? 0) } : null,
    passRate: s.pass_rate ?? null,
    costUsd: s.cost_usd ?? null,
    tokens: s.input_tokens !== undefined || s.output_tokens !== undefined ? (s.input_tokens ?? 0) + (s.output_tokens ?? 0) : null,
    latencyMs: s.latency_ms ?? null,
    judge: s.judge ?? null,
  };
};
