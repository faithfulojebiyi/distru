import { apiUrl } from '../config/api-url';
import { handleSessionExpiry } from '../lib/session-expiry';
import { ApiError } from './errors';

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

  const response = await fetch(`${apiUrl}${url}`, {
    ...init,
    headers,
    credentials: 'include',
  });

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
