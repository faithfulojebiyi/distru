/** A non-2xx response from the agent server, carrying its status and parsed body. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** No response at all (server down or restarting, network gone): an ApiError with status 0 and code `network`. */
export const NETWORK_ERROR_MESSAGE = 'Can’t reach the agent server. Retrying…';

export const isNetworkError = (error: unknown): boolean =>
  (error instanceof ApiError && error.status === 0) || (error instanceof TypeError && /fetch|network|load failed/i.test(error.message));

const statusOf = (error: unknown): number | null =>
  error instanceof ApiError ? error.status : null;

export const isSessionExpiredError = (error: unknown): boolean =>
  statusOf(error) === 401;

export const isForbiddenError = (error: unknown): boolean =>
  statusOf(error) === 403;

export const isNotFoundError = (error: unknown): boolean =>
  statusOf(error) === 404;

/** The HTTP status of a failed API call, or null when it never got a response. */
export const apiErrorStatus = (error: unknown): number | null => statusOf(error);

/** Prefers the server's own message over a generic one. */
export const apiErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Request failed';

/** Statuses whose server message tells the user what to do: invalid input, a conflict, a rate limit. */
export const ACTIONABLE_ERROR_STATUSES: ReadonlySet<number> = new Set([
  400, 409, 422, 429,
]);

/** The server's machine-readable error code, such as `policy_violation`, when it sent one. */
export const apiErrorCode = (error: unknown): string | null => {
  if (!(error instanceof ApiError)) return null;
  const { body } = error;
  if (!body || typeof body !== 'object' || !('code' in body)) return null;
  return typeof body.code === 'string' ? body.code : null;
};

/**
 * A 404 from a route the server does not have yet (Hono's plain "404 Not Found"), as opposed to a JSON
 * `{ error: 'not_found' }` for a missing record. Screens built ahead of their route show "not available yet".
 */
export const isRouteMissingError = (error: unknown): boolean =>
  error instanceof ApiError &&
  error.status === 404 &&
  !(error.body && typeof error.body === 'object' && 'error' in error.body);
