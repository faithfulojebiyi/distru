import { AsyncLocalStorage } from 'node:async_hooks';
import { createMiddleware } from 'hono/factory';

/**
 * The request a piece of work belongs to, carried with AsyncLocalStorage so deep code (the audit
 * sink) can stamp `audit_event.request_id` without threading it through the harness.
 */
export interface RequestScope {
  requestId: string;
  via: 'http' | 'mcp';
}

export const requestScope = new AsyncLocalStorage<RequestScope>();

export const currentRequestId = (): string | null => requestScope.getStore()?.requestId ?? null;

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** A well-formed client `x-request-id`, else a fresh UUID. */
export function requestIdFrom(header: string | undefined | null): string {
  return header && SAFE_ID.test(header) ? header : crypto.randomUUID();
}

/** Runs the rest of the request inside a `RequestScope` and echoes the id as `x-request-id`. */
export const requestIdMiddleware = createMiddleware(async (c, next) => {
  const requestId = requestIdFrom(c.req.header('x-request-id'));
  c.header('x-request-id', requestId);
  await requestScope.run({ requestId, via: c.req.path === '/mcp' ? 'mcp' : 'http' }, () => next());
});
