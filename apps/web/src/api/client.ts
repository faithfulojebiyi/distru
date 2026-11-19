import { apiUrl } from '../config/api-url';
import { handleSessionExpiry } from '../lib/session-expiry';
import { ApiError, NETWORK_ERROR_MESSAGE } from './errors';

const messageOf = (body: unknown, status: number): string => {
  if (body && typeof body === 'object') {
    const { message, error } = body as { message?: unknown; error?: unknown };
    if (typeof message === 'string' && message) return message;
    if (typeof error === 'string' && error) return error;
  }
  if (typeof body === 'string' && body) return body;
  return `Request failed with status ${status}`;
};

const parseBody = (text: string, contentType: string | null): unknown => {
  if (!text) return undefined;
  if (contentType?.includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
};

/**
 * The Orval mutator: every generated function calls `apiFetch<T>(url, init)`
 * (Orval's `client: 'fetch'` with `includeHttpResponseReturnType: false`).
 * It prefixes the agent server origin, sends the Better Auth session cookie,
 * resolves to the parsed body, and turns a non-2xx response into ApiError so
 * TanStack Query's error handling sees one shape.
 */
export const apiFetch = async <T>(
  url: string,
  init?: RequestInit,
): Promise<T> => {
  const headers = new Headers(init?.headers);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');

  let response: Response;
  try {
    response = await fetch(`${apiUrl}${url}`, {
      ...init,
      headers,
      credentials: 'include',
    });
  } catch (error) {
    // An abort is the caller's own doing (TanStack Query cancelling); rethrow it as is.
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    // No response at all: the server is down or restarting. One shape for screens and retries.
    throw new ApiError(0, { code: 'network' }, NETWORK_ERROR_MESSAGE);
  }

  const body = parseBody(
    await response.text(),
    response.headers.get('content-type'),
  );

  if (!response.ok) {
    if (response.status === 401) handleSessionExpiry();
    throw new ApiError(response.status, body, messageOf(body, response.status));
  }

  return body as T;
};

export default apiFetch;
