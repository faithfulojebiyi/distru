import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_PRICING, LlmGateway, type EvalMode, type Pricing } from './llm';
import { buildReport, gitSha, type EvalReport } from './report';
import { runScenario, type ScenarioResult } from './runner';
import type { Scenario } from './scenario';
import type { EvalResultSink } from './sink';

export const PACKAGE_DIR = resolve(import.meta.dir, '..');
export const REPO_ROOT = resolve(PACKAGE_DIR, '..', '..');
export const RECORDINGS_DIR = join(PACKAGE_DIR, 'recordings');
export const REPORTS_DIR = join(PACKAGE_DIR, 'reports');

/** `KEY=value` lines of a dotenv file (no expansion). Values are never logged. */
export function readDotenv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m?.[1] && m[2] !== undefined) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

export interface AgentConfig {
  model: string;
  pricing: Pricing;
  apiKey?: string;
}

/** Model, pricing and key: process env first, then apps/agent/.env (the agent's own config). */
export function agentConfig(): AgentConfig {
  const file = readDotenv(join(REPO_ROOT, 'apps', 'agent', '.env'));
  const get = (k: string) => process.env[k] ?? file[k];
  const model = (get('EVALS_MODEL') ?? get('OPS_AGENT_MODEL') ?? 'anthropic/claude-sonnet-5-5').replace(/^anthropic\//, '');
  const num = (k: string, d: number) => {
    const v = Number(get(k));
    return Number.isFinite(v) && v >= 0 && get(k) !== undefined ? v : d;
  };
  const apiKey = get('ANTHROPIC_API_KEY');
  return {
    model,
    pricing: { inputUsdPerMTok: num('LLM_INPUT_USD_PER_MTOK', DEFAULT_PRICING.inputUsdPerMTok), outputUsdPerMTok: num('LLM_OUTPUT_USD_PER_MTOK', DEFAULT_PRICING.outputUsdPerMTok) },
    ...(apiKey ? { apiKey } : {}),
  };
}

export interface SuiteOptions {
  mode: EvalMode;
  scenarios: Scenario[];
  judge: boolean;
  force?: boolean;
  budgetUsd?: number;
  recordingsDir?: string;
  config?: AgentConfig;
  sinks?: EvalResultSink[];
  log?: (line: string) => void;
}

export async function runSuite(options: SuiteOptions): Promise<EvalReport> {
  const config = options.config ?? agentConfig();
  const gateway = new LlmGateway({ budgetUsd: options.budgetUsd ?? 5 });
  const startedAt = new Date();
  const batchId = `${options.mode}-${startedAt.toISOString().replace(/[:.]/g, '-')}`;
  const results: ScenarioResult[] = [];
  try {
    for (const scenario of options.scenarios) {
      results.push(
        await runScenario(scenario, {
          mode: options.mode,
          model: config.model,
          judge: options.judge,
          pricing: config.pricing,
          recordingsDir: options.recordingsDir ?? RECORDINGS_DIR,
          gateway,
          ...(config.apiKey && options.mode !== 'offline' ? { apiKey: config.apiKey } : {}),
          ...(options.force ? { force: true } : {}),
          ...(options.log ? { log: options.log } : {}),
        }),
      );
    }
  } finally {
    await gateway.stop();
  }
  const report = buildReport({ batchId, startedAt, mode: options.mode, model: config.model, judge: options.judge, gitSha: gitSha(REPO_ROOT), scenarios: results, realCostUsd: gateway.spentUsd });
  for (const sink of options.sinks ?? []) {
    try {
      await sink.write(report);
    } finally {
      await sink.close?.();
    }
  }
  return report;
}
