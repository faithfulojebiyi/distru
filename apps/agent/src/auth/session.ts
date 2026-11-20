import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { USER_ROLES, type UserRole } from '../db/schema';

/** The authenticated principal exposed to custom routes. */
export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  /** Pseudo-users only (A2A token callers): the human user id the caller acts for (the token's creator). */
  onBehalfOf?: string;
};

/** Resolves the caller from request headers (cookie or bearer). Injected so routes are testable. */
export type SessionResolver = (headers: Headers) => Promise<SessionUser | null>;

export type AuthVariables = { user: SessionUser | null };

function toRole(value: unknown): UserRole {
  return USER_ROLES.includes(value as UserRole) ? (value as UserRole) : 'operator';
}

/** Production resolver backed by Better Auth's session API. */
export function betterAuthResolver(auth: {
  api: { getSession: (opts: { headers: Headers }) => Promise<unknown> };
}): SessionResolver {
  return async (headers) => {
    const result = (await auth.api.getSession({ headers })) as {
      user: { id: string; email: string; name: string; role?: unknown };
    } | null;
    if (!result?.user) return null;
    const { id, email, name, role } = result.user;
    return { id, email, name, role: toRole(role) };
  };
}

/** Attaches `c.var.user` (or null) to every request it wraps. Never rejects. */
export function sessionMiddleware(resolve: SessionResolver): MiddlewareHandler<{ Variables: AuthVariables }> {
  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    let user: SessionUser | null = null;
    try {
      user = await resolve(c.req.raw.headers);
    } catch {
      user = null;
    }
    c.set('user', user);
    await next();
  });
}

/** 401 unless a session is present. */
export const requireUser = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'unauthorized', message: 'Sign in required' }, 401);
  await next();
});

/** 401 without a session, 403 when the session's role is not one of `roles`. */
export function requireRole(...roles: UserRole[]) {
  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthorized', message: 'Sign in required' }, 401);
    if (!roles.includes(user.role)) {
      return c.json({ error: 'forbidden', message: `Requires role: ${roles.join(' or ')}` }, 403);
    }
    await next();
  });
}
