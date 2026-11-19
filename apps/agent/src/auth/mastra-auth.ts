import type { MastraUser } from '@mastra/core/auth';
import { MastraAuthProvider, getWebRequest, type MastraAuthRequest } from '@mastra/core/server';
import type { SessionResolver, SessionUser } from './session';

/**
 * Protects Mastra's built-in routes (/api/agents, /api/workflows, /api/memory, ...) with the same
 * Better Auth session the web app and custom routes use. Mastra calls `authenticateToken` even when
 * no Bearer header is present, so we resolve from the full request headers (cookie or bearer).
 *
 * Default Mastra auth paths apply: `/api/*` protected, `/api` and `/api/auth/*` public. Our own
 * raw Hono routes (/api/health, /api/me, /api/proposals, ...) are not Mastra routes and enforce
 * auth with `requireUser` / `requireRole` instead.
 */
export class BetterAuthMastraProvider extends MastraAuthProvider<SessionUser> {
  constructor(private readonly resolve: SessionResolver) {
    super({ name: 'better-auth' });
  }

  async authenticateToken(_token: string, request: MastraAuthRequest): Promise<SessionUser | null> {
    const headers = getWebRequest(request)?.headers ?? ('headers' in request ? request.headers : undefined);
    if (!headers) return null;
    return this.resolve(headers);
  }

  authorizeUser(user: SessionUser): boolean {
    return Boolean(user?.id);
  }

  /** Memory threads / workflow runs are owned by the authenticated user, never a client-supplied id. */
  mapUserToResourceId(user: SessionUser): string {
    return user.id;
  }

  override toMastraUser(user: SessionUser): MastraUser {
    return { id: user.id, email: user.email, name: user.name, role: user.role };
  }
}
