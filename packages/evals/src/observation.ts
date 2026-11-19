import { z } from 'zod';

/**
 * What one scenario run produced, reduced to the facts assertions look at. The runner builds it
 * from the workflow state, the harness proposal + audit trail, the mock's write counters and the
 * LLM emulator's call log; the assertion engine only ever sees this (so it is unit-testable).
 */
export const ObservedLineSchema = z.object({
  productId: z.string(),
  sku: z.string().nullable(),
  quantity: z.number(),
  unitPrice: z.number().nullable(),
  vendorId: z.string().nullable(),
  locationId: z.string().nullable(),
});
export type ObservedLine = z.infer<typeof ObservedLineSchema>;

export const UsageSchema = z
  .object({
    llmCalls: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
  })
  .meta({ id: 'EvalUsage' });
export type Usage = z.infer<typeof UsageSchema>;

export const ObservationSchema = z
  .object({
    kind: z.enum(['restock', 'copilot']),
    /** Workflow run state: suspended / success / failed (null for copilot). */
    runState: z.string().nullable(),
    /** RestockResult.status when the run finished (executed, nothing_to_order, rejected, denied, failed). */
    resultStatus: z.string().nullable(),
    proposal: z
      .object({
        id: z.string(),
        status: z.string(),
        policyOutcome: z.string().nullable(),
        totalValue: z.number().nullable(),
        ops: z.array(z.object({ action: z.string(), status: z.string().nullable(), verified: z.boolean().nullable() })),
      })
      .nullable(),
    lines: z.array(ObservedLineSchema),
    /** The merged Inventory Analyst output (merge-at-risk step). */
    atRisk: z.array(z.object({ sku: z.string(), recommendation: z.string().nullable(), flaggedBy: z.string().nullable(), retailSignal: z.string().nullable() })),
    vetoed: z.array(z.object({ sku: z.string().nullable(), productId: z.string(), reasons: z.array(z.string()) })),
    suspicious: z.array(z.object({ sku: z.string().nullable(), source: z.string() })),
    revisions: z.number().int().nonnegative(),
    auditTypes: z.array(z.string()),
    writes: z.object({ purchases: z.number().int().nonnegative(), tasks: z.number().int().nonnegative() }),
    /** Purchase + task writes made by a second harness.execute (null when not re-executed). */
    reexecuteWrites: z.number().int().nonnegative().nullable(),
    toolCalls: z.array(z.string()),
    /** Agent ids that ran (workflow agent calls, or Copilot subagent delegations + the Ops Lead). */
    agents: z.array(z.string()),
    answer: z.string().nullable(),
    usage: UsageSchema,
    latencyMs: z.number().nonnegative(),
    error: z.string().nullable(),
  })
  .meta({ id: 'EvalObservation' });
export type Observation = z.infer<typeof ObservationSchema>;

export function emptyObservation(kind: Observation['kind']): Observation {
  return {
    kind,
    runState: null,
    resultStatus: null,
    proposal: null,
    lines: [],
    atRisk: [],
    vetoed: [],
    suspicious: [],
    revisions: 0,
    auditTypes: [],
    writes: { purchases: 0, tasks: 0 },
    reexecuteWrites: null,
    toolCalls: [],
    agents: [],
    answer: null,
    usage: { llmCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    latencyMs: 0,
    error: null,
  };
}
