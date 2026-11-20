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

/** Distru writes: REST purchase / task POSTs, and inventory adjustments saved (any surface). */
export const WritesSchema = z.object({ purchases: z.number().int().nonnegative(), tasks: z.number().int().nonnegative(), adjustments: z.number().int().nonnegative().default(0) });
export type Writes = z.infer<typeof WritesSchema>;

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
    kind: z.enum(['restock', 'copilot', 'vendor_reply', 'distru_webhook', 'mcp_call', 'proposal']),
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
        title: z.string().nullable().default(null),
        summary: z.string().nullable().default(null),
        /** `meta.titleSource`: who wrote the headline (agent / template / caller). */
        titleSource: z.string().nullable().default(null),
        ops: z.array(
          z.object({
            action: z.string(),
            status: z.string().nullable(),
            verified: z.boolean().nullable(),
            /** Field changes (last path segment, before → after). */
            diff: z.array(z.object({ field: z.string(), before: z.unknown(), after: z.unknown() })).default([]),
            /** The op input as JSON (truncated). */
            input: z.string().default(''),
          }),
        ),
      })
      .nullable(),
    lines: z.array(ObservedLineSchema),
    /** The merged Inventory Analyst output (merge-at-risk step). */
    atRisk: z.array(z.object({ sku: z.string(), recommendation: z.string().nullable(), flaggedBy: z.string().nullable(), retailSignal: z.string().nullable() })),
    vetoed: z.array(z.object({ sku: z.string().nullable(), productId: z.string(), reasons: z.array(z.string()) })),
    suspicious: z.array(z.object({ sku: z.string().nullable(), source: z.string() })),
    revisions: z.number().int().nonnegative(),
    auditTypes: z.array(z.string()),
    writes: WritesSchema,
    /** Purchase + task writes made by a second harness.execute (null when not re-executed). */
    reexecuteWrites: z.number().int().nonnegative().nullable(),
    toolCalls: z.array(z.string()),
    /** Agent ids that ran (workflow agent calls, or Copilot subagent delegations + the Ops Lead). */
    agents: z.array(z.string()),
    answer: z.string().nullable(),
    /** Slack button clicks on the approval message, in order. */
    slackClicks: z.array(z.object({ as: z.string(), outcome: z.enum(['refused', 'decided']), message: z.string().nullable() })).default([]),
    /** The undo of an executed proposal (trigger.undo). */
    undo: z
      .object({
        proposalId: z.string(),
        status: z.string(),
        policyRules: z.array(z.string()),
        /** `<action>.undo` ops, with their summaries. */
        ops: z.array(z.object({ action: z.string(), summary: z.string().nullable() })),
        notUndoable: z.array(z.object({ action: z.string(), reason: z.string() })),
        proposerApproveRefused: z.boolean(),
        finalStatus: z.string().nullable(),
        /** What the undo left in the world, checked after it executed. */
        after: z
          .object({
            purchasesStillThere: z.number().int(),
            tasksStillThere: z.number().int(),
            capsNotRestored: z.number().int(),
            emailsBefore: z.number().int(),
            emailsAfter: z.number().int(),
            undoOpsExecuted: z.number().int(),
            undoOps: z.number().int(),
          })
          .nullable(),
      })
      .nullable()
      .default(null),
    /**
     * Executions of the proposal (trigger `proposal`): the first after approval, then each resume, with
     * every op's outcome and the Distru writes made during that step.
     */
    executions: z
      .array(
        z.object({
          proposalStatus: z.string(),
          error: z.string().nullable(),
          ops: z.array(z.object({ action: z.string(), status: z.string(), recordId: z.string().nullable(), error: z.string().nullable(), mismatches: z.string() })),
          writes: WritesSchema,
        }),
      )
      .default([]),
    /** Restock runs started by webhook deliveries (distru_webhook). */
    runsStarted: z.number().int().nonnegative().default(0),
    webhookDeliveries: z.array(z.object({ status: z.string(), eventId: z.string().nullable() })).default([]),
    /** The MCP call (mcp_call): tools the token lists, and whether the call was refused. */
    mcp: z.object({ tools: z.array(z.string()), refused: z.boolean(), error: z.string().nullable(), proposalsAfter: z.number().int() }).nullable().default(null),
    /** Semantic recall (recallSetup): documents indexed and every recall_search result's passages, in call order. */
    recall: z
      .object({
        documents: z.number().int().nonnegative(),
        searches: z.array(
          z.object({
            query: z.string(),
            passages: z.array(z.object({ ref: z.string(), date: z.string(), subject: z.string().nullable(), from: z.string().nullable(), text: z.string().nullable(), suspicious: z.boolean(), score: z.number() })),
          }),
        ),
      })
      .nullable()
      .default(null),
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
    writes: { purchases: 0, tasks: 0, adjustments: 0 },
    reexecuteWrites: null,
    toolCalls: [],
    agents: [],
    answer: null,
    slackClicks: [],
    undo: null,
    executions: [],
    runsStarted: 0,
    webhookDeliveries: [],
    mcp: null,
    recall: null,
    usage: { llmCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    latencyMs: 0,
    error: null,
  };
}
