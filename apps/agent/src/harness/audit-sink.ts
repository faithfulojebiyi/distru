import type { AuditEvent, AuditSink } from '@ops/harness';
import type { DB } from '../db/client';
import { auditEvent } from '../db/schema';
import { currentRequestId } from './request-context';

/** Maps a harness AuditEvent onto `audit_event` columns (+ the type-specific `data`). */
export function auditValues(event: AuditEvent): typeof auditEvent.$inferInsert {
  const data: Record<string, unknown> = event.data;
  const opIndex = typeof data.opIndex === 'number' ? data.opIndex : null;
  return {
    id: event.id,
    type: event.type,
    actor: event.actor,
    actorKind: event.actor.kind,
    actorId: event.actor.id,
    proposalId: event.proposalId,
    opIndex,
    requestId: currentRequestId(),
    data,
    at: new Date(event.at),
  };
}

/** Append-only `AuditSink`: INSERT into `audit_event`, never UPDATE/DELETE. */
export class DrizzleAuditSink implements AuditSink {
  constructor(private readonly db: DB) {}

  async append(event: AuditEvent): Promise<void> {
    await this.db.insert(auditEvent).values(auditValues(event));
  }
}
