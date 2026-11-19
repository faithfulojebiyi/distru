import type { AuditSink } from '@ops/harness';

/** Audit sink for route tests / setups without one (trigger audit events are dropped). */
export const discardAudit: AuditSink = { append: async () => {} };

/** Reads the raw request body exactly once (signatures are over the raw bytes, never re-serialized JSON). */
export const rawBodyOf = (request: Request): Promise<string> => request.clone().text();
