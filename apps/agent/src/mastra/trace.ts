import { z } from 'zod';

/**
 * The run timeline's unit: one agent call inside a workflow step, with its tool calls, token usage
 * and cost estimate. Stored in workflow step outputs (Mastra run storage), so `GET /api/runs/:id`
 * rebuilds the timeline from the run snapshot alone. Mastra AI tracing records the same calls as
 * spans (agent run → model steps → tool calls) in `mastra_ai_spans`.
 */
export const ToolCallTraceSchema = z
  .object({
    tool: z.string(),
    startedAt: z.iso.datetime(),
    durationMs: z.number().nonnegative(),
    ok: z.boolean(),
    error: z.string().nullable(),
  })
  .meta({ id: 'ToolCallTrace' });
export type ToolCallTrace = z.infer<typeof ToolCallTraceSchema>;

export const TokenUsageSchema = z
  .object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative(), total: z.number().int().nonnegative() })
  .meta({ id: 'TokenUsage' });
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const AgentTraceEntrySchema = z
  .object({
    agent: z.string().describe('Agent id, e.g. inventory-analyst'),
    agentName: z.string(),
    step: z.string().describe('Workflow step that made the call'),
    label: z.string().describe('What the call was for, e.g. "location Oakland" or "vendor X (revision 1)"'),
    round: z.number().int().nullable(),
    status: z.enum(['success', 'failed']),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime(),
    tokens: TokenUsageSchema,
    costUsd: z.number().nonnegative().describe('Estimate from LLM_*_USD_PER_MTOK'),
    toolCalls: z.array(ToolCallTraceSchema),
    summary: z.string().nullable(),
    error: z.string().nullable(),
  })
  .meta({ id: 'AgentTraceEntry' });
export type AgentTraceEntry = z.infer<typeof AgentTraceEntrySchema>;

export interface Pricing {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

export function estimateCostUsd(tokens: Pick<TokenUsage, 'input' | 'output'>, pricing: Pricing): number {
  const usd = (tokens.input * pricing.inputUsdPerMTok + tokens.output * pricing.outputUsdPerMTok) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

export function sumTrace(entries: readonly AgentTraceEntry[]): { tokens: TokenUsage; costUsd: number } {
  const tokens = { input: 0, output: 0, total: 0 };
  let costUsd = 0;
  for (const e of entries) {
    tokens.input += e.tokens.input;
    tokens.output += e.tokens.output;
    tokens.total += e.tokens.total;
    costUsd += e.costUsd;
  }
  return { tokens, costUsd: Math.round(costUsd * 1_000_000) / 1_000_000 };
}
