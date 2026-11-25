import type { Mastra } from '@mastra/core';
import type { TracingContext } from '@mastra/core/observability';
import { RequestContext } from '@mastra/core/request-context';
import { anySignal, Budget, BudgetExceededError } from '@ops/harness';
import type { z } from 'zod';
import { AGENT_BUDGETS, AGENT_MAX_STEPS, AGENTS, RUN_BUDGET, type AgentKey } from '../agents/roster';
import { AgentRun, attachAgentRun, type DraftProposal } from '../tools/run-context';
import { estimateCostUsd, sumTrace, type AgentTraceEntry, type Pricing } from '../trace';
import { PROMPT_CACHE_OPTIONS } from '../agents/shared';

export interface AgentCallArgs<T> {
  mastra: Mastra;
  agent: AgentKey;
  prompt: string;
  /** Structured output: the workflow only ever consumes validated objects. */
  schema: z.ZodType<T>;
  step: string;
  label: string;
  round?: number | null;
  /** The run's draft proposal (Planner calls): `propose_*` tool calls accumulate into it. */
  draft?: DraftProposal;
  pricing: Pricing;
  /** Everything the run has spent so far, for the run-level budget. */
  spent?: readonly AgentTraceEntry[];
  tracingContext?: TracingContext;
  abortSignal?: AbortSignal;
}

export interface AgentCallResult<T> {
  object: T;
  trace: AgentTraceEntry;
}

function summaryOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('summary' in value)) return null;
  return typeof value.summary === 'string' ? value.summary : null;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * One model step's usage, including prompt-cache reads / writes. Mastra (AI SDK) reports `inputTokens`
 * as the total (cache included), `cachedInputTokens` (reads) and `cacheCreationInputTokens` (writes).
 */
export function cacheUsageOf(usage: unknown): { input: number; output: number; total: number; cacheRead: number; cacheWrite: number } {
  const u = typeof usage === 'object' && usage !== null ? (usage as Record<string, unknown>) : {};
  const input = num(u.inputTokens);
  const output = num(u.outputTokens);
  return { input, output, total: num(u.totalTokens) || input + output, cacheRead: num(u.cachedInputTokens), cacheWrite: num(u.cacheCreationInputTokens) };
}

/** Thrown when an agent call fails; carries the trace entry so the failure shows on the timeline/logs. */
export class AgentCallError extends Error {
  readonly trace: AgentTraceEntry;
  constructor(message: string, trace: AgentTraceEntry, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AgentCallError';
    this.trace = trace;
  }
}

/**
 * One agent call from a workflow step: per-agent `Budget` (tool calls charge steps; each model step
 * charges tokens + estimated cost; wall-clock is enforced via the abort signal), run-level budget
 * check, structured output parsed with the step's zod schema, tracing nested under the workflow step
 * span, and a timeline entry (`AgentTraceEntry`) for the Runs page.
 */
export async function callAgent<T>(args: AgentCallArgs<T>): Promise<AgentCallResult<T>> {
  const { agent: key, pricing } = args;
  const meta = AGENTS[key];

  if (args.spent?.length) {
    const used = sumTrace(args.spent);
    if (used.tokens.total > RUN_BUDGET.maxTokens) throw new BudgetExceededError('tokens', RUN_BUDGET.maxTokens, used.tokens.total);
    if (used.costUsd > RUN_BUDGET.maxCostUsd) throw new BudgetExceededError('costUsd', RUN_BUDGET.maxCostUsd, used.costUsd);
  }

  const budget = new Budget(AGENT_BUDGETS[key]);
  const run = new AgentRun(key, { budget, draft: args.draft ?? null });
  const requestContext = new RequestContext();
  attachAgentRun(requestContext, run);

  const limitMs = AGENT_BUDGETS[key].maxWallClockMs;
  // Wall-clock: check() aborts the budget's signal (cancelling the in-flight model call) once over the limit.
  const timer = limitMs
    ? setTimeout(() => {
        try {
          budget.check();
        } catch {
          /* signal aborted; generate() rejects */
        }
      }, limitMs + 10)
    : null;
  const tokens = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 };
  const startedAt = new Date();

  const entry = (status: 'success' | 'failed', summary: string | null, error: string | null): AgentTraceEntry => ({
    agent: meta.id,
    agentName: meta.name,
    step: args.step,
    label: args.label,
    round: args.round ?? null,
    status,
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    tokens: { ...tokens },
    costUsd: estimateCostUsd(tokens, pricing),
    toolCalls: [...run.toolCalls],
    summary,
    error,
  });

  try {
    const agent = args.mastra.getAgentById(meta.id);
    const result = await agent.generate(args.prompt, {
      // 'warn' hands back the raw object instead of throwing, so parseAgentOutput can repair what's repairable.
      structuredOutput: { schema: args.schema, errorStrategy: 'warn' },
      // Prompt caching: system prompt + tools (agent instructions) and the growing loop (request level).
      ...PROMPT_CACHE_OPTIONS,
      requestContext,
      maxSteps: AGENT_MAX_STEPS[key],
      abortSignal: anySignal(budget.signal, args.abortSignal),
      ...(args.tracingContext ? { tracingContext: args.tracingContext } : {}),
      onStepFinish: (step) => {
        const usage = cacheUsageOf(step.usage);
        tokens.input += usage.input;
        tokens.output += usage.output;
        tokens.total += usage.total;
        tokens.cacheRead += usage.cacheRead;
        tokens.cacheWrite += usage.cacheWrite;
        // Throws BudgetExceededError (and aborts the signal) once a limit is crossed.
        budget.charge({ tokens: usage.total, costUsd: estimateCostUsd(usage, pricing) });
      },
    });
    budget.check();
    const object = parseAgentOutput(args.schema, result.object);
    return { object, trace: entry('success', summaryOf(object), null) };
  } catch (err) {
    const reason = budget.signal.aborted && budget.signal.reason instanceof Error ? budget.signal.reason : err;
    const message = reason instanceof Error ? reason.message : String(reason);
    throw new AgentCallError(`${meta.name} (${args.label}) failed: ${message}`, entry('failed', null, message), { cause: reason });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Validates an agent's structured output. The one thing repaired is a string over its length limit (models
 * routinely write a longer "reason" than asked): it's shortened to fit with an ellipsis. Anything else that
 * doesn't match the schema still throws, so the workflow only ever sees valid objects.
 */
export function parseAgentOutput<T>(schema: z.ZodType<T>, value: unknown): T {
  let current = value;
  for (let attempt = 0; attempt < 20; attempt++) {
    const parsed = schema.safeParse(current);
    if (parsed.success) return parsed.data;
    const overlong = parsed.error.issues.filter(
      (i): i is z.core.$ZodIssueTooBig => i.code === 'too_big' && i.origin === 'string' && typeof i.maximum === 'number',
    );
    if (overlong.length === 0) throw parsed.error;
    current = structuredClone(current);
    for (const issue of overlong) {
      const max = Number(issue.maximum);
      let parent: unknown = current;
      for (const key of issue.path.slice(0, -1)) parent = (parent as Record<PropertyKey, unknown> | null)?.[key];
      const key = issue.path.at(-1);
      const node = parent as Record<PropertyKey, unknown> | null;
      const text = key === undefined ? undefined : node?.[key];
      if (!node || key === undefined || typeof text !== 'string') throw parsed.error;
      node[key] = `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
    }
  }
  return schema.parse(current);
}
