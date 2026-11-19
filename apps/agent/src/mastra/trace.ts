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
    /** Tool input (trimmed with `trimForTrace`). */
    args: z.unknown().optional(),
    /** Tool output (trimmed; untrusted ERP text stays wrapped as-is). */
    result: z.unknown().optional(),
  })
  .meta({ id: 'ToolCallTrace' });
export type ToolCallTrace = z.infer<typeof ToolCallTraceSchema>;

export const TokenUsageSchema = z
  .object({
    /** All input tokens, including those read from / written to the prompt cache. */
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    /** Input tokens served from Anthropic's prompt cache (billed at ~0.1× input). */
    cacheRead: z.number().int().nonnegative().default(0),
    /** Input tokens written to the prompt cache (billed at ~1.25× input, 5-minute TTL). */
    cacheWrite: z.number().int().nonnegative().default(0),
  })
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
  /** Cache read price as a multiple of the input price. Default 0.1 (Anthropic). */
  cacheReadMultiplier?: number;
  /** Cache write (5-minute TTL) price as a multiple of the input price. Default 1.25 (Anthropic). */
  cacheWriteMultiplier?: number;
}

/**
 * Estimated cost. `input` includes cache reads and writes (that is how the provider reports it), so the
 * uncached part is `input − cacheRead − cacheWrite`; reads cost ~0.1× and writes ~1.25× the input price.
 */
export function estimateCostUsd(tokens: Pick<TokenUsage, 'input' | 'output'> & Partial<Pick<TokenUsage, 'cacheRead' | 'cacheWrite'>>, pricing: Pricing): number {
  const read = tokens.cacheRead ?? 0;
  const write = tokens.cacheWrite ?? 0;
  const uncached = Math.max(0, tokens.input - read - write);
  const inputUsd = (uncached + read * (pricing.cacheReadMultiplier ?? 0.1) + write * (pricing.cacheWriteMultiplier ?? 1.25)) * pricing.inputUsdPerMTok;
  const usd = (inputUsd + tokens.output * pricing.outputUsdPerMTok) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

export function sumTrace(entries: readonly AgentTraceEntry[]): { tokens: TokenUsage; costUsd: number } {
  const tokens = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 };
  let costUsd = 0;
  for (const e of entries) {
    tokens.input += e.tokens.input;
    tokens.output += e.tokens.output;
    tokens.total += e.tokens.total;
    tokens.cacheRead += e.tokens.cacheRead ?? 0;
    tokens.cacheWrite += e.tokens.cacheWrite ?? 0;
    costUsd += e.costUsd;
  }
  return { tokens, costUsd: Math.round(costUsd * 1_000_000) / 1_000_000 };
}

const isUntrustedWrapper = (v: Record<string, unknown>) => typeof v.untrusted_text === 'string' && 'source' in v;

/**
 * Bounded copy of a tool input/output for the run timeline: arrays keep their first `maxItems`
 * (plus a `{ _truncated: n }` marker), long strings are cut, depth is capped. Untrusted-text
 * wrappers (`{ untrusted_text, source, suspicious }`) are kept exactly as-is so the UI shows the
 * quoted data, flagged, never as instructions.
 */
export function trimForTrace(value: unknown, opts: { maxItems?: number; maxString?: number; maxDepth?: number } = {}): unknown {
  const maxItems = opts.maxItems ?? 20;
  const maxString = opts.maxString ?? 2000;
  const maxDepth = opts.maxDepth ?? 6;
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return v.length > maxString ? `${v.slice(0, maxString)}… [${v.length - maxString} more chars]` : v;
    if (v === null || typeof v !== 'object') return v;
    if (depth >= maxDepth) return Array.isArray(v) ? `[array(${v.length})]` : '[object]';
    if (Array.isArray(v)) {
      const head = v.slice(0, maxItems).map((x) => walk(x, depth + 1));
      return v.length > maxItems ? [...head, { _truncated: v.length - maxItems }] : head;
    }
    const rec = v as Record<string, unknown>;
    if (isUntrustedWrapper(rec)) return { ...rec };
    return Object.fromEntries(Object.entries(rec).map(([k, x]) => [k, walk(x, depth + 1)]));
  };
  return walk(value, 0);
}
