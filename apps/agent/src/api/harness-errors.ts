import {
  ConcurrentModificationError,
  DecisionConflictError,
  ForbiddenError,
  IllegalTransitionError,
  InputValidationError,
  NotFoundError,
  PolicyDeniedError,
  type PolicyEvaluation,
} from '@ops/harness';

export type HarnessHttpError =
  | { status: 400; body: { error: 'invalid_input'; message: string } }
  | { status: 403; body: { error: 'forbidden'; message: string } }
  | { status: 404; body: { error: 'not_found'; message: string } }
  | { status: 409; body: { error: 'decision_conflict' | 'concurrent_modification'; message: string } }
  | { status: 409; body: { error: 'policy_denied'; message: string; evaluation: PolicyEvaluation } };

/**
 * Harness error → HTTP. Returns null for anything else (the app's onError turns it into a 500).
 *
 * | Harness error                                   | HTTP |
 * |-------------------------------------------------|------|
 * | InputValidationError                            | 400  |
 * | ForbiddenError (missing scope, separation of duties) | 403 |
 * | NotFoundError                                   | 404  |
 * | DecisionConflictError, IllegalTransitionError   | 409 decision_conflict |
 * | ConcurrentModificationError                     | 409 concurrent_modification |
 * | PolicyDeniedError                               | 409 policy_denied (+ evaluation) |
 */
export function toHttpError(err: unknown): HarnessHttpError | null {
  if (err instanceof InputValidationError) return { status: 400, body: { error: 'invalid_input', message: err.message } };
  if (err instanceof ForbiddenError) return { status: 403, body: { error: 'forbidden', message: err.message } };
  if (err instanceof NotFoundError) return { status: 404, body: { error: 'not_found', message: err.message } };
  if (err instanceof DecisionConflictError || err instanceof IllegalTransitionError) {
    return { status: 409, body: { error: 'decision_conflict', message: err.message } };
  }
  if (err instanceof ConcurrentModificationError) {
    return { status: 409, body: { error: 'concurrent_modification', message: err.message } };
  }
  if (err instanceof PolicyDeniedError) {
    return { status: 409, body: { error: 'policy_denied', message: err.message, evaluation: err.evaluation } };
  }
  return null;
}
