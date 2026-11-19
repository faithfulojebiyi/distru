import { z } from 'zod';
import { FindingOutcomeSchema, ScopeSchema as HarnessScopeSchema, SeveritySchema } from '@ops/harness';
import {
  ACTOR_KINDS,
  DECISIONS,
  OP_STATUSES,
  POLICY_OUTCOMES,
  PRINCIPAL_KINDS,
  PROPOSAL_STATUSES,
  RISKS,
  USER_ROLES,
} from '../db/schema';

/*
 * Boundary schemas for custom routes. Every exported top-level schema carries `.meta({ id })` so the
 * OpenAPI document emits it under components/schemas with a stable name (Orval → nice type names).
 */

export const ErrorResponseSchema = z
  .object({ error: z.string(), message: z.string().optional() })
  .meta({ id: 'ErrorResponse' });

export const HealthSchema = z
  .object({
    status: z.literal('ok'),
    time: z.iso.datetime(),
    database: z.enum(['ok', 'error']),
  })
  .meta({ id: 'Health' });

export const UserRoleSchema = z.enum(USER_ROLES).meta({ id: 'UserRole' });

export const MeSchema = z
  .object({
    id: z.string(),
    email: z.email(),
    name: z.string(),
    role: UserRoleSchema,
  })
  .meta({ id: 'Me' });

// ---------------------------------------------------------------------------
// Harness model (packages/harness), re-declared with stable component names
// ---------------------------------------------------------------------------

export const ProposalStatusSchema = z.enum(PROPOSAL_STATUSES).meta({ id: 'ProposalStatus' });
export const PrincipalKindSchema = z.enum(PRINCIPAL_KINDS).meta({ id: 'PrincipalKind' });
export const ActorKindSchema = z.enum(ACTOR_KINDS).meta({ id: 'ActorKind' });
export const ScopeSchema = z.enum(HarnessScopeSchema.options).meta({ id: 'Scope' });
export const RiskSchema = z.enum(RISKS).meta({ id: 'Risk' });
export const OpStatusSchema = z.enum(OP_STATUSES).meta({ id: 'OpStatus' });
export const PolicyOutcomeSchema = z.enum(POLICY_OUTCOMES).meta({ id: 'PolicyOutcome' });
export const DecisionKindSchema = z.enum(DECISIONS).meta({ id: 'DecisionKind' });

export const PrincipalSchema = z
  .object({
    kind: PrincipalKindSchema,
    id: z.string(),
    scopes: z.array(ScopeSchema),
    label: z.string().optional(),
  })
  .meta({ id: 'Principal' });

/** Who did something: a principal, or the harness itself (`kind: 'system'`, e.g. the executor). */
export const ActorSchema = z
  .object({
    kind: ActorKindSchema,
    id: z.string(),
    scopes: z.array(ScopeSchema).optional(),
    label: z.string().optional(),
  })
  .meta({ id: 'Actor' });

export const PolicyReasonSchema = z
  .object({
    rule: z.string(),
    outcome: z.enum(FindingOutcomeSchema.options),
    severity: z.enum(SeveritySchema.options),
    message: z.string(),
  })
  .meta({ id: 'PolicyReason' });

export const PolicyEvaluationSchema = z
  .object({ outcome: PolicyOutcomeSchema, reasons: z.array(PolicyReasonSchema) })
  .meta({ id: 'PolicyEvaluation' });

export const FieldChangeSchema = z
  .object({
    /** Path into the payload; keyed array elements appear as `id=<key>`, new ones as `new:<i>`. */
    path: z.array(z.union([z.string(), z.number()])),
    kind: z.enum(['added', 'removed', 'changed']),
    before: z.unknown(),
    after: z.unknown(),
  })
  .meta({ id: 'FieldChange' });

export const MismatchSchema = z
  .object({ path: z.array(z.union([z.string(), z.number()])), expected: z.unknown(), actual: z.unknown() })
  .meta({ id: 'Mismatch' });

export const SerializedErrorSchema = z
  .object({ name: z.string(), message: z.string(), code: z.string().optional() })
  .meta({ id: 'SerializedError' });

const OutputValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const OpResultSchema = z
  .object({
    recordId: z.string().nullable(),
    deduplicated: z.boolean(),
    attempts: z.number().int(),
    mismatches: z.array(MismatchSchema),
    error: SerializedErrorSchema.nullable(),
    finishedAt: z.string(),
    /** Values this op's record exports to later ops of the proposal (`{{op:<index>.<key>}}`), e.g. `{ purchase_number }`. */
    outputs: z.record(z.string(), OutputValueSchema).optional(),
    /** Op references substituted into this op's payload at execute time (placeholder → value). The stored payload keeps the placeholder. */
    resolved: z.record(z.string(), OutputValueSchema).optional(),
  })
  .meta({ id: 'OpResult' });

export const ProposalOpSchema = z
  .object({
    index: z.number().int(),
    action: z.string(),
    resource: z.string(),
    risk: RiskSchema,
    input: z.unknown(),
    /** ERP record before the write (null when creating). */
    before: z.unknown(),
    /** Exact request body that will be sent. */
    payload: z.unknown(),
    diff: z.array(FieldChangeSchema),
    summary: z.string().nullable(),
    value: z.number().nullable(),
    vendorIds: z.array(z.string()).nullable(),
    idempotencyKey: z.string(),
    status: OpStatusSchema,
    result: OpResultSchema.nullable(),
  })
  .meta({ id: 'ProposalOp' });

export const DecisionSchema = z
  .object({
    decision: DecisionKindSchema,
    by: PrincipalSchema,
    reason: z.string().nullable(),
    edited: z.boolean(),
    at: z.iso.datetime(),
  })
  .meta({ id: 'Decision' });

export const ExecutionSchema = z
  .object({
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    error: SerializedErrorSchema.nullable(),
  })
  .meta({ id: 'Execution' });

/** The connector (system) an op writes to, from the registry. */
export const OpConnectorSchema = z
  .object({ id: z.string(), system: z.string() })
  .meta({ id: 'OpConnector' });

/** One op of a proposal, for inbox rows: what it does, how risky, where it writes. */
export const ProposalOpSummarySchema = z
  .object({
    index: z.number().int(),
    action: z.string(),
    summary: z.string().nullable(),
    risk: RiskSchema,
    status: OpStatusSchema,
    value: z.number().nullable(),
    /** Connector that executes the op (null when the action is no longer registered). */
    connector: OpConnectorSchema.nullable(),
    /** Systems the write reaches beyond the connector (MCP bridge classification, e.g. QuickBooks, Metrc); null when unknown. */
    reaches: z.array(z.string()).nullable(),
  })
  .meta({ id: 'ProposalOpSummary' });

export const ProposalSummarySchema = z
  .object({
    id: z.uuid(),
    version: z.number().int(),
    status: ProposalStatusSchema,
    title: z.string().nullable(),
    createdBy: PrincipalSchema,
    policyOutcome: PolicyOutcomeSchema,
    totalValue: z.number().nullable(),
    opCount: z.number().int(),
    actions: z.array(z.string()),
    /** Highest op risk (null for a proposal without ops). */
    maxRisk: RiskSchema.nullable(),
    opSummaries: z.array(ProposalOpSummarySchema),
    /** Set when this proposal undoes another one (`meta.undoOf.proposalId`). */
    undoOf: z.string().nullable(),
    workflowRunId: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'ProposalSummary' });

export const UndoOpInfoSchema = z
  .object({
    opIndex: z.number().int(),
    action: z.string(),
    summary: z.string().nullable(),
    canUndo: z.boolean(),
    /** Why the op cannot be undone (e.g. "The email was already delivered…"); null when it can. */
    reason: z.string().nullable(),
    /** The undo proposal covering this op (pending/approved/executing/executed/failed), if any. */
    undoProposalId: z.string().nullable(),
  })
  .meta({ id: 'UndoOpInfo' });

export const UndoInfoSchema = z
  .object({
    available: z.boolean(),
    reason: z.string().nullable(),
    ops: z.array(UndoOpInfoSchema),
    /** Latest live undo proposal for this proposal (not rejected/denied). */
    undoProposalId: z.string().nullable(),
    /** This proposal is itself an undo of that proposal. */
    undoOf: z.string().nullable(),
    /** Undo allowed until (ISO) when an undo window is configured. */
    until: z.string().nullable(),
  })
  .meta({ id: 'UndoInfo' });

export const ProposalDetailSchema = ProposalSummarySchema.extend({
  rationale: z.string().nullable(),
  meta: z.record(z.string(), z.unknown()),
  ops: z.array(ProposalOpSchema),
  policy: PolicyEvaluationSchema,
  decision: DecisionSchema.nullable(),
  execution: ExecutionSchema.nullable(),
  /** Which executed ops can be undone (POST /api/proposals/{id}/undo), and why not. */
  undo: UndoInfoSchema,
}).meta({ id: 'ProposalDetail' });

export const ProposalListSchema = z
  .object({ items: z.array(ProposalSummarySchema) })
  .meta({ id: 'ProposalList' });

export const ListProposalsQuerySchema = z.object({
  status: ProposalStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Rows to skip (paging; the MCP server's cursors encode it). */
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const ProposalIdParamsSchema = z.object({ id: z.uuid() });

export const OpEditSchema = z
  .object({
    opIndex: z.number().int().nonnegative(),
    /** Replacement input; the op is re-planned, re-diffed and policy re-runs. */
    input: z.unknown(),
  })
  .meta({ id: 'OpEdit' });

export const DecisionRequestSchema = z
  .object({
    decision: DecisionKindSchema,
    reason: z.string().max(2000).optional(),
    /** Approve-only edits. A `deny` after re-evaluation blocks the approval (409 policy_denied). */
    edits: z.array(OpEditSchema).max(100).optional(),
  })
  .meta({ id: 'DecisionRequest' });

export const DecisionResponseSchema = z
  .object({ proposal: ProposalDetailSchema })
  .meta({ id: 'DecisionResponse' });

/** 409 when an approver's edits were denied by policy: the decision was not recorded. */
export const PolicyDeniedResponseSchema = z
  .object({ error: z.literal('policy_denied'), message: z.string(), evaluation: PolicyEvaluationSchema })
  .meta({ id: 'PolicyDeniedResponse' });

export const AuditEventSchema = z
  .object({
    id: z.uuid(),
    /** Insertion order (total, unlike timestamps). */
    seq: z.number().int(),
    type: z.string(),
    actor: ActorSchema,
    proposalId: z.string().nullable(),
    opIndex: z.number().int().nullable(),
    data: z.record(z.string(), z.unknown()),
    at: z.iso.datetime(),
    /** Request that caused the event (`x-request-id`), when it came from an API or MCP call. */
    requestId: z.string().nullable(),
    /** For op events: the op's idempotency key and field-level diff (from the proposal). */
    idempotencyKey: z.string().nullable(),
    diff: z.array(FieldChangeSchema).nullable(),
  })
  .meta({ id: 'AuditEvent' });

export const AuditEventListSchema = z
  .object({ items: z.array(AuditEventSchema) })
  .meta({ id: 'AuditEventList' });

export const ListAuditEventsQuerySchema = z.object({
  proposalId: z.uuid().optional(),
  type: z.string().optional(),
  /** `desc` (default): newest first. `asc`: chronological, e.g. a proposal timeline. */
  order: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export const RunStatusSchema = z
  .enum(['running', 'suspended', 'success', 'failed', 'canceled', 'pending', 'waiting', 'tripwire', 'bailed', 'paused', 'skipped'])
  .meta({ id: 'RunStatus' });

export const RunProposalLinkSchema = z
  .object({ id: z.uuid(), status: ProposalStatusSchema, title: z.string().nullable(), totalValue: z.number().nullable() })
  .meta({ id: 'RunProposalLink' });

export const TokenUsageSchema = z
  .object({ input: z.number().int(), output: z.number().int(), total: z.number().int() })
  .meta({ id: 'RunTokenUsage' });

/** Spend and activity of a run so far (sum over its agent calls). */
export const RunTotalsSchema = z
  .object({ tokens: TokenUsageSchema, costUsd: z.number(), agentCalls: z.number().int(), toolCalls: z.number().int() })
  .meta({ id: 'RunTotals' });

export const RunSummarySchema = z
  .object({
    runId: z.string(),
    workflowId: z.string(),
    status: RunStatusSchema,
    triggeredBy: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    /** The proposal the run created (null before the propose step, or when nothing needed ordering). */
    proposal: RunProposalLinkSchema.nullable(),
    totals: RunTotalsSchema,
  })
  .meta({ id: 'RunSummary' });

export const RunListSchema = z.object({ items: z.array(RunSummarySchema) }).meta({ id: 'RunList' });

export const ListRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const RunIdParamsSchema = z.object({ id: z.string().min(1).max(200) });

export const ToolCallTraceSchema = z
  .object({
    tool: z.string(),
    startedAt: z.iso.datetime(),
    durationMs: z.number(),
    ok: z.boolean(),
    error: z.string().nullable(),
    /** Tool input as the agent sent it (trimmed: long arrays/strings cut, `_truncated` markers). */
    args: z.unknown().optional(),
    /** Tool output (trimmed the same way). ERP free text stays wrapped as `{ untrusted_text, source, suspicious }`. */
    result: z.unknown().optional(),
  })
  .meta({ id: 'RunToolCall' });

/** One agent call on the timeline (agent, the step that called it, tokens, cost estimate, tool calls). */
export const RunAgentCallSchema = z
  .object({
    agent: z.string(),
    agentName: z.string(),
    step: z.string(),
    label: z.string(),
    round: z.number().int().nullable(),
    status: z.enum(['success', 'failed']),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime(),
    tokens: TokenUsageSchema,
    costUsd: z.number(),
    toolCalls: z.array(ToolCallTraceSchema),
    summary: z.string().nullable(),
    error: z.string().nullable(),
  })
  .meta({ id: 'RunAgentCall' });

export const RunStepSchema = z
  .object({
    stepId: z.string(),
    /** Mastra step status: success | failed | suspended | running | waiting | paused | skipped | canceled. */
    status: z.string(),
    startedAt: z.iso.datetime().nullable(),
    endedAt: z.iso.datetime().nullable(),
    suspendedAt: z.iso.datetime().nullable(),
    resumedAt: z.iso.datetime().nullable(),
    /** foreach steps: number of iterations. */
    iterations: z.number().int().nullable(),
    agents: z.array(RunAgentCallSchema),
    error: z.string().nullable(),
  })
  .meta({ id: 'RunStep' });

export const RunDetailSchema = RunSummarySchema.extend({
  input: z.record(z.string(), z.unknown()).nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  /** Steps in execution order, each with the agent calls it made. */
  steps: z.array(RunStepSchema),
  /** Payload of the suspended step (e.g. `{ proposalId }` while waiting for a decision). */
  suspendPayload: z.record(z.string(), z.unknown()).nullable(),
}).meta({ id: 'RunDetail' });

export const StartRunRequestSchema = z
  .object({
    scenarioNote: z.string().max(1000).optional(),
    locationIds: z.array(z.string().min(1)).max(20).optional(),
    vendorIds: z.array(z.string().min(1)).max(50).optional(),
    productIds: z.array(z.string().min(1)).max(100).optional(),
  })
  .meta({ id: 'StartRunRequest' });

export const StartRunResponseSchema = z
  .object({ runId: z.string(), workflowId: z.string(), status: z.literal('started') })
  .meta({ id: 'StartRunResponse' });

export const ConnectorToolSchema = z
  .object({
    toolName: z.string(),
    name: z.string(),
    kind: z.enum(['read', 'action']),
    requiredScope: ScopeSchema,
    risk: RiskSchema.nullable(),
    description: z.string(),
  })
  .meta({ id: 'ConnectorTool' });

export const ConnectorSummarySchema = z
  .object({
    id: z.string(),
    system: z.string(),
    description: z.string(),
    health: z.object({ ok: z.boolean(), detail: z.string().nullable() }),
    readTools: z.number().int(),
    actions: z.number().int(),
    tools: z.array(ConnectorToolSchema),
  })
  .meta({ id: 'ConnectorSummary' });

export const ConnectorListSchema = z.object({ items: z.array(ConnectorSummarySchema) }).meta({ id: 'ConnectorList' });

export const DistruWebhookHeadersSchema = z.object({
  'x-distru-signature': z.string().optional().describe('sha256=<hex HMAC-SHA256 of the raw body with DISTRU_WEBHOOK_SECRET>'),
});

export const WebhookResponseSchema = z
  .object({
    ok: z.literal(true),
    action: z.enum(['restock_requested', 'ignored']),
    reason: z.string().nullable(),
  })
  .meta({ id: 'WebhookResponse' });

export type Me = z.infer<typeof MeSchema>;
export type ProposalSummary = z.infer<typeof ProposalSummarySchema>;
export type ProposalDetail = z.infer<typeof ProposalDetailSchema>;
export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type RunSummary = z.infer<typeof RunSummarySchema>;
export type RunDetail = z.infer<typeof RunDetailSchema>;
export type RunStep = z.infer<typeof RunStepSchema>;
export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;
export type ConnectorSummary = z.infer<typeof ConnectorSummarySchema>;
export type WebhookResponse = z.infer<typeof WebhookResponseSchema>;
