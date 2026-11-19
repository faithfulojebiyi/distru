import { Budget, type Principal } from '@ops/harness';
import type { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import type { OpPreview } from '../../harness/dry-run';
import { AGENT_BUDGETS, AGENTS, principalFor, type AgentKey } from '../agents/roster';
import type { ToolCallTrace } from '../trace';

/**
 * A draft op: what a `propose_*` tool call accumulated. Nothing has been written anywhere; the
 * workflow turns the run's draft into exactly one harness proposal after review.
 */
export const DraftOpSchema = z
  .object({
    /** Registry action name, e.g. `distru.purchases.upsert`. */
    action: z.string(),
    /** Validated action input (the exact thing `harness.propose` will receive). */
    input: z.unknown(),
    /** Dedupe key: the same vendor + location (or the same existing record) replaces the earlier op. */
    key: z.string(),
    summary: z.string().nullable(),
    value: z.number().nullable(),
    vendorIds: z.array(z.string()).nullable(),
    risk: z.enum(['low', 'medium', 'high']),
  })
  .meta({ id: 'DraftOp' });
export type DraftOp = z.infer<typeof DraftOpSchema>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** One op per vendor + receiving location (or per existing record when updating one). */
export function draftKeyOf(preview: OpPreview): string {
  const input = isRecord(preview.input) ? preview.input : {};
  const record = str(input.purchase_id) ?? str(input.id);
  if (record) return `${preview.action}|record:${record}`;
  const vendor = preview.vendorIds?.join(',') ?? str(input.vendor_id) ?? '?';
  const location = str(input.location_id) ?? '?';
  return `${preview.action}|vendor:${vendor}|location:${location}`;
}

export function draftOpFrom(preview: OpPreview): DraftOp {
  return {
    action: preview.action,
    input: preview.input,
    key: draftKeyOf(preview),
    summary: preview.summary,
    value: preview.value,
    vendorIds: preview.vendorIds,
    risk: preview.risk,
  };
}

/** The draft proposal a workflow run accumulates through `propose_*` tool calls. */
export class DraftProposal {
  readonly #ops = new Map<string, DraftOp>();

  constructor(initial: readonly DraftOp[] = []) {
    for (const op of initial) this.#ops.set(op.key, op);
  }

  /** Adds an op, replacing an earlier one with the same key (a revision replaces, never duplicates). */
  upsert(preview: OpPreview): { op: DraftOp; replaced: boolean } {
    const op = draftOpFrom(preview);
    const replaced = this.#ops.has(op.key);
    this.#ops.set(op.key, op);
    return { op, replaced };
  }

  remove(key: string): boolean {
    return this.#ops.delete(key);
  }

  get ops(): DraftOp[] {
    return [...this.#ops.values()];
  }
}

/**
 * Per-agent-call state the harness tools read from the Mastra request context: the agent's budget,
 * its tool-call trace and (inside a workflow) the run's draft. Keyed per agent, because Mastra
 * copies a supervisor's request context into its subagents' runs: a subagent must never charge or
 * draft into its supervisor's state. The principal comes from the tool itself, not from here.
 */
export class AgentRun {
  readonly agent: AgentKey;
  readonly principal: Principal;
  readonly budget: Budget;
  readonly toolCalls: ToolCallTrace[] = [];
  readonly draft: DraftProposal | null;

  constructor(agent: AgentKey, options: { budget?: Budget; draft?: DraftProposal | null } = {}) {
    this.agent = agent;
    this.principal = principalFor(agent);
    this.budget = options.budget ?? new Budget(AGENT_BUDGETS[agent]);
    this.draft = options.draft ?? null;
  }
}

export const agentRunKey = (agent: AgentKey) => `ops.agentRun.${AGENTS[agent].id}`;

/** Attach an `AgentRun` to a request context (the workflow does this before each agent call). */
export function attachAgentRun(requestContext: RequestContext, run: AgentRun): void {
  requestContext.set(agentRunKey(run.agent), run);
}

/**
 * The agent's run state for this call. Outside a workflow (Copilot chat, Studio) there is none
 * yet: one is created with the agent's default budget and stored on the call's request context,
 * so every tool call in that conversation turn charges the same budget.
 */
export function agentRunFor(agent: AgentKey, requestContext: RequestContext | undefined): AgentRun {
  const existing = requestContext?.get(agentRunKey(agent));
  if (existing instanceof AgentRun && existing.agent === agent) return existing;
  const run = new AgentRun(agent);
  requestContext?.set(agentRunKey(agent), run);
  return run;
}
