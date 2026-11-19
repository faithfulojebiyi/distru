import type { AuditEvent } from './audit';
import type { PolicyRuleConfig } from './policy';
import type { Proposal } from './proposal';

/**
 * Persistence for proposals. Postgres: `proposal` + `proposal_op` rows written in one transaction.
 * `compareAndSet` is the exactly-once primitive:
 *   UPDATE proposal SET ..., version = $next WHERE id = $id AND version = $expected
 * and must return false (not throw) when zero rows matched.
 */
export interface ProposalStore {
  create(proposal: Proposal): Promise<void>;
  get(id: string): Promise<Proposal | null>;
  /** Persist `next` iff the stored version equals `expectedVersion`. `next.version` is `expectedVersion + 1`. */
  compareAndSet(next: Proposal, expectedVersion: number): Promise<boolean>;
}

/** Append-only audit trail. Postgres: INSERT into `audit_event` (never UPDATE/DELETE). */
export interface AuditSink {
  append(event: AuditEvent): Promise<void>;
}

/** Source of policy rule configs. Postgres: SELECT from `policy_rule` (per tenant). */
export interface PolicyRuleSource {
  list(): Promise<readonly PolicyRuleConfig[]>;
}

export interface Clock {
  now(): Date;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/**
 * Durable step boundary. Inngest: `(id, fn) => step.run(id, fn)`; Mastra workflow steps likewise.
 * A step that completed is never re-run on replay; its stored result is returned instead.
 */
export interface StepRunner {
  run<T>(stepId: string, fn: () => Promise<T>): Promise<T>;
}

/** Classifies ERP/client errors. Distru: 429 and 5xx retryable, 429 `Retry-After` honoured. */
export interface ErrorClassifier {
  isRetryable(err: unknown): boolean;
  retryAfterMs?(err: unknown): number | undefined;
}

export type IdGenerator = () => string;
