import type { Mastra } from '@mastra/core';
import type { TracingContext } from '@mastra/core/observability';
import { RequestContext } from '@mastra/core/request-context';
import { anySignal, Budget, BudgetExceededError } from '@ops/harness';
import type { z } from 'zod';
import { AGENT_BUDGETS, AGENT_MAX_STEPS, AGENTS, RUN_BUDGET, type AgentKey } from '../agents/roster';
import { AgentRun, attachAgentRun, type DraftProposal } from '../tools/run-context';
import { estimateCostUsd, sumTrace, type AgentTraceEntry, type Pricing } from '../trace';

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
  const tokens = { input: 0, output: 0, total: 0 };
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
      structuredOutput: { schema: args.schema },
      requestContext,
      maxSteps: AGENT_MAX_STEPS[key],
      abortSignal: anySignal(budget.signal, args.abortSignal),
      ...(args.tracingContext ? { tracingContext: args.tracingContext } : {}),
      onStepFinish: (step) => {
        const input = num(step.usage?.inputTokens);
        const output = num(step.usage?.outputTokens);
        tokens.input += input;
        tokens.output += output;
        tokens.total += num(step.usage?.totalTokens) || input + output;
        // Throws BudgetExceededError (and aborts the signal) once a limit is crossed.
        budget.charge({ tokens: num(step.usage?.totalTokens) || input + output, costUsd: estimateCostUsd({ input, output }, pricing) });
      },
    });
    budget.check();
    const object = args.schema.parse(result.object);
    return { object, trace: entry('success', summaryOf(object), null) };
  } catch (err) {
    const reason = budget.signal.aborted && budget.signal.reason instanceof Error ? budget.signal.reason : err;
    const message = reason instanceof Error ? reason.message : String(reason);
    throw new AgentCallError(`${meta.name} (${args.label}) failed: ${message}`, entry('failed', null, message), { cause: reason });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
