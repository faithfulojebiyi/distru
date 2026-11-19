import { z } from 'zod';
import {
  ACTOR_TYPES,
  APPROVAL_DECISIONS,
  PROPOSAL_OP_KINDS,
  PROPOSAL_OP_STATUSES,
  PROPOSAL_STATUSES,
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

export const ProposalStatusSchema = z.enum(PROPOSAL_STATUSES).meta({ id: 'ProposalStatus' });
export const ActorTypeSchema = z.enum(ACTOR_TYPES).meta({ id: 'ActorType' });
export const ApprovalDecisionSchema = z.enum(APPROVAL_DECISIONS).meta({ id: 'ApprovalDecision' });

export const ProposalSummarySchema = z
  .object({
    id: z.uuid(),
    title: z.string(),
    summary: z.string().nullable(),
    status: ProposalStatusSchema,
    workflowRunId: z.string().nullable(),
    createdByType: ActorTypeSchema,
    createdByUserId: z.string().nullable(),
    opCount: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'ProposalSummary' });

export const ProposalOpSchema = z
  .object({
    id: z.uuid(),
    seq: z.number().int(),
    resource: z.string(),
    op: z.enum(PROPOSAL_OP_KINDS),
    payload: z.record(z.string(), z.unknown()),
    before: z.record(z.string(), z.unknown()).nullable(),
    diff: z.unknown(),
    idempotencyKey: z.string(),
    status: z.enum(PROPOSAL_OP_STATUSES),
    result: z.unknown(),
    distruRecordId: z.string().nullable(),
  })
  .meta({ id: 'ProposalOp' });

export const ApprovalSchema = z
  .object({
    id: z.uuid(),
    proposalId: z.uuid(),
    decision: ApprovalDecisionSchema,
    decidedBy: z.string(),
    reason: z.string().nullable(),
    decidedAt: z.iso.datetime(),
  })
  .meta({ id: 'Approval' });

export const ProposalDetailSchema = ProposalSummarySchema.extend({
  reasoning: z.string().nullable(),
  policyChecks: z.array(z.unknown()),
  ops: z.array(ProposalOpSchema),
  approval: ApprovalSchema.nullable(),
}).meta({ id: 'ProposalDetail' });

export const ProposalListSchema = z
  .object({ items: z.array(ProposalSummarySchema) })
  .meta({ id: 'ProposalList' });

export const ListProposalsQuerySchema = z.object({
  status: ProposalStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const ProposalIdParamsSchema = z.object({ id: z.uuid() });

export const DecisionRequestSchema = z
  .object({
    decision: ApprovalDecisionSchema,
    reason: z.string().max(2000).optional(),
  })
  .meta({ id: 'DecisionRequest' });

export const DecisionResponseSchema = z
  .object({ proposal: ProposalSummarySchema, approval: ApprovalSchema })
  .meta({ id: 'DecisionResponse' });

export const AuditEventSchema = z
  .object({
    id: z.uuid(),
    actorType: ActorTypeSchema,
    actorUserId: z.string().nullable(),
    actorAgentId: z.string().nullable(),
    action: z.string(),
    subjectType: z.string(),
    subjectId: z.string().nullable(),
    data: z.record(z.string(), z.unknown()),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'AuditEvent' });

export const AuditEventListSchema = z
  .object({ items: z.array(AuditEventSchema) })
  .meta({ id: 'AuditEventList' });

export const ListAuditEventsQuerySchema = z.object({
  subjectType: z.string().optional(),
  subjectId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const RunStatusSchema = z
  .enum(['running', 'suspended', 'success', 'failed', 'canceled', 'pending', 'waiting'])
  .meta({ id: 'RunStatus' });

export const RunSummarySchema = z
  .object({
    runId: z.string(),
    workflowId: z.string(),
    status: RunStatusSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'RunSummary' });

export const RunListSchema = z.object({ items: z.array(RunSummarySchema) }).meta({ id: 'RunList' });

export const ListRunsQuerySchema = z.object({
  workflowId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type Me = z.infer<typeof MeSchema>;
export type ProposalSummary = z.infer<typeof ProposalSummarySchema>;
export type ProposalDetail = z.infer<typeof ProposalDetailSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type RunSummary = z.infer<typeof RunSummarySchema>;
