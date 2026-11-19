import type { MastraUser } from '@mastra/core/auth';
import { MastraAuthProvider, getWebRequest, type MastraAuthRequest } from '@mastra/core/server';
import type { SessionResolver, SessionUser } from './session';

/** Email/password sign-in that returns a Better Auth session (token + Set-Cookie headers). */
export type CredentialsSignIn = (email: string, password: string) => Promise<{ token: string; cookies: string[] }>;

/**
 * The Mastra auth paths Studio calls under the API prefix. They must reach Mastra, not Better Auth
 * (which owns the rest of /api/auth/*). Better Auth uses none of these paths.
 */
export const MASTRA_STUDIO_AUTH_PATHS = ['/api/auth/capabilities', '/api/auth/me', '/api/auth/credentials/sign-in'] as const;

/**
 * Protects Mastra's built-in routes (/api/agents, /api/workflows, /api/memory, ...) with the same
 * Better Auth session the web app and custom routes use. Mastra calls `authenticateToken` even when
 * no Bearer header is present, so we resolve from the full request headers (cookie or bearer).
 *
 * Default Mastra auth paths apply: `/api/*` protected, `/api` and `/api/auth/*` public. Our own
 * raw Hono routes (/api/health, /api/me, /api/proposals, ...) are not Mastra routes and enforce
 * auth with `requireUser` / `requireRole` instead.
 *
 * Studio support:
 * - `getCurrentUser` lets `GET /api/auth/capabilities` and `/api/auth/me` report the signed-in user.
 * - When `signIn` is given (development only, see src/mastra/index.ts) the provider also implements
 *   Mastra's credentials interface, so standalone Studio shows an email/password form that signs in
 *   through Better Auth and gets the normal session cookie. Sign-up from Studio is always disabled.
 */
export class BetterAuthMastraProvider extends MastraAuthProvider<SessionUser> {
  constructor(
    private readonly resolve: SessionResolver,
    private readonly credentials?: CredentialsSignIn,
  ) {
    super({ name: 'better-auth' });
    // Mastra detects capabilities by method presence, so only expose sign-in when it's enabled.
    if (!credentials) Object.defineProperty(this, 'signIn', { value: undefined });
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

  /** IUserProvider (used by Studio's capabilities / me endpoints). */
  async getCurrentUser(request: Request): Promise<MastraUser | null> {
    const user = await this.resolve(request.headers).catch(() => null);
    return user ? this.toMastraUser(user) : null;
  }

  async getUser(): Promise<MastraUser | null> {
    return null;
  }

  /** ICredentialsProvider (dev only): Studio's login form → Better Auth email sign-in. */
  async signIn(email: string, password: string): Promise<{ user: MastraUser; token: string; cookies: string[] }> {
    if (!this.credentials) throw new Error('Credentials sign-in is disabled');
    const { token, cookies } = await this.credentials(email, password);
    const user = await this.resolve(new Headers({ authorization: `Bearer ${token}` }));
    if (!user) throw new Error('Invalid email or password');
    return { user: this.toMastraUser(user), token, cookies };
  }

  async signUp(): Promise<never> {
    throw new Error('Sign-up is not available from Studio');
  }

  isSignUpEnabled(): boolean {
    return false;
  }
}
