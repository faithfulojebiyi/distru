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
]);
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type AuditEventType = AuditEvent['type'];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An audit event before the harness stamps `id` and `at`. */
export type AuditEventInput = DistributiveOmit<AuditEvent, 'id' | 'at'>;
export type AuditEventOf<T extends AuditEventType> = Extract<AuditEvent, { type: T }>;
