import type { z } from 'zod';
import type { PolicyEvaluation } from './policy';

/** Machine-readable error codes. Adapters map these to HTTP status / MCP error codes. */
export type HarnessErrorCode =
  | 'forbidden'
  | 'invalid_input'
  | 'not_found'
  | 'illegal_transition'
  | 'decision_conflict'
  | 'concurrent_modification'
  | 'policy_denied'
  | 'budget_exceeded'
  | 'cancelled'
  | 'infrastructure'
  | 'unresolved_reference'
  | 'undo_unavailable'
  | 'not_resumable';

export abstract class HarnessError extends Error {
  abstract readonly code: HarnessErrorCode;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ForbiddenError extends HarnessError {
  readonly code = 'forbidden';
}

export class InputValidationError extends HarnessError {
  readonly code = 'invalid_input';
  readonly issues: readonly z.core.$ZodIssue[];
  constructor(message: string, issues: readonly z.core.$ZodIssue[] = []) {
    super(message);
    this.issues = issues;
  }
}

export class NotFoundError extends HarnessError {
  readonly code = 'not_found';
}

export class IllegalTransitionError extends HarnessError {
  readonly code = 'illegal_transition';
  readonly from: string;
  readonly to: string;
  constructor(from: string, to: string) {
    super(`Illegal proposal transition: ${from} -> ${to}`);
    this.from = from;
    this.to = to;
  }
}

/** Raised when a proposal was already decided (or is no longer awaiting a decision). */
export class DecisionConflictError extends HarnessError {
  readonly code = 'decision_conflict';
  readonly proposalId: string;
  readonly currentStatus: string;
  constructor(proposalId: string, currentStatus: string) {
    super(`Proposal ${proposalId} is not awaiting a decision (status: ${currentStatus})`);
    this.proposalId = proposalId;
    this.currentStatus = currentStatus;
  }
}

/** Optimistic-concurrency failure outside of decisions (e.g. two executors racing). */
export class ConcurrentModificationError extends HarnessError {
  readonly code = 'concurrent_modification';
}

export class CancelledError extends HarnessError {
  readonly code = 'cancelled';
}

/** An approver's edits produced a `deny` policy outcome; the decision was not recorded. */
export class PolicyDeniedError extends HarnessError {
  readonly code = 'policy_denied';
  readonly evaluation: PolicyEvaluation;
  constructor(message: string, evaluation: PolicyEvaluation) {
    super(message);
    this.evaluation = evaluation;
  }
}

/** A port (store, audit sink) failed mid-execution. Never treated as an op failure; the run stays resumable. */
export class InfrastructureError extends HarnessError {
  readonly code = 'infrastructure';
}

/** Resume was requested for a proposal that is not `failed` (nothing to resume). */
export class NotResumableError extends HarnessError {
  readonly code = 'not_resumable';
  readonly proposalId: string;
  readonly currentStatus: string;
  constructor(proposalId: string, currentStatus: string) {
    super(`Proposal ${proposalId} cannot be resumed (status: ${currentStatus}; only failed proposals resume)`);
    this.proposalId = proposalId;
    this.currentStatus = currentStatus;
  }
}
