import { z } from 'zod';
import { MismatchSchema } from './verify';
import { PolicyOutcomeSchema, PolicyReasonSchema } from './policy';
import { SerializedErrorSchema } from './proposal';
import { ActorSchema } from './scopes';

const base = {
  id: z.string(),
  at: z.string(),
  actor: ActorSchema,
  proposalId: z.string().nullable(),
};

const opRef = { opIndex: z.number().int(), action: z.string() };
/** Op references resolved into the payload at execute time (placeholder → value). */
const resolvedRefs = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional();

const event = <T extends string, D extends z.ZodRawShape>(type: T, data: D) =>
  z.object({ ...base, type: z.literal(type), data: z.object(data) });

export const AuditEventSchema = z.discriminatedUnion('type', [
  event('proposal.created', { opCount: z.number().int(), actions: z.array(z.string()), totalValue: z.number().nullable() }),
  event('policy.evaluated', { trigger: z.enum(['propose', 'edit']), outcome: PolicyOutcomeSchema, reasons: z.array(PolicyReasonSchema) }),
  event('proposal.decided', { decision: z.enum(['approve', 'reject']), reason: z.string().nullable(), edited: z.boolean() }),
  event('proposal.decision_blocked', { reasons: z.array(PolicyReasonSchema) }),
  event('proposal.execution_started', { resumed: z.boolean() }),
  event('op.executed', { ...opRef, recordId: z.string(), idempotencyKey: z.string(), attempts: z.number().int(), resolved: resolvedRefs }),
  event('op.deduplicated', { ...opRef, recordId: z.string(), idempotencyKey: z.string(), attempts: z.number().int(), resolved: resolvedRefs }),
  event('op.retry', { ...opRef, attempt: z.number().int(), delayMs: z.number(), error: SerializedErrorSchema }),
  event('op.verified', { ...opRef, recordId: z.string() }),
  event('op.verify_failed', { ...opRef, recordId: z.string(), mismatches: z.array(MismatchSchema) }),
  event('op.failed', { ...opRef, attempts: z.number().int(), error: SerializedErrorSchema }),
  event('proposal.executed', { opCount: z.number().int() }),
  event('proposal.failed', { failedOpIndex: z.number().int().nullable(), error: SerializedErrorSchema }),
  event('budget.exceeded', { dimension: z.string(), limit: z.number(), used: z.number() }),
  // Undo: recorded on the *original* proposal when a compensating proposal is created for it.
  event('proposal.undo_proposed', {
    undoProposalId: z.string(),
    opIndexes: z.array(z.number().int()),
    notUndoable: z.array(z.object({ opIndex: z.number().int(), reason: z.string() })),
    reason: z.string(),
  }),
  // App-level governance events (no proposal): policy edits and MCP client tokens.
  event('policy.changed', { key: z.string(), before: z.unknown(), after: z.unknown() }),
  event('mcp_token.created', { tokenId: z.string(), name: z.string(), scopes: z.array(z.string()) }),
  event('mcp_token.revoked', { tokenId: z.string(), name: z.string() }),
  // Every call to our MCP server, with the caller's stated `intent` (Distru MCP convention).
  event('mcp.tool_called', {
    tool: z.string(),
    intent: z.string(),
    tokenId: z.string(),
    outcome: z.enum(['ok', 'error']),
    error: z.string().nullable(),
  }),
  // Triggers (inbound webhooks): `proposalId` is null; the actor is `system:trigger:<id>`.
  event('trigger.received', {
    triggerId: z.string(),
    source: z.string(),
    connectorId: z.string().nullable(),
    eventName: z.string(),
    webhookId: z.string(),
    untrustedFields: z.array(z.string()),
    /** Verified but not handled by the trigger (acknowledged, nothing queued). */
    ignored: z.boolean(),
  }),
  event('trigger.rejected', { triggerId: z.string(), source: z.string(), connectorId: z.string().nullable(), reason: z.string(), message: z.string() }),
]);
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type AuditEventType = AuditEvent['type'];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An audit event before the harness stamps `id` and `at`. */
export type AuditEventInput = DistributiveOmit<AuditEvent, 'id' | 'at'>;
export type AuditEventOf<T extends AuditEventType> = Extract<AuditEvent, { type: T }>;
