import type { Context, MiddlewareHandler } from 'hono';
import { MASTRA_STUDIO_AUTH_PATHS } from '../auth/mastra-auth';

/**
 * Deny-by-default gate in front of Mastra's built-in routes.
 *
 * MastraServer exposes far more than the app uses: workflow start / time-travel / restart / step
 * execution, agent tool execution, stored agents, processors, logs, observability, ... and its auth
 * provider admits any signed-in user. Several of those bypass the harness's human gates (e.g.
 * time-travelling `restockWorkflow` to `execute`, or calling a `propose_*` tool as an agent principal).
 * Only what the dashboard and A2A callers actually use is let through; everything else is a 404.
 *
 * It must be registered after every custom route (createApiRoutes, /mcp, webhooks, Better Auth,
 * Inngest) and before `MastraServer.init()`: a custom route answers first and never reaches it, so
 * it only ever sees requests headed for Mastra (or nowhere).
 *
 * Used by apps/web (src/lib/mastra-client.ts):
 * - Copilot: `POST /api/agents/ops-lead/stream` (and `/generate`), memory threads + messages.
 * A2A (README "A2A"): the Ops Lead's agent card and JSON-RPC endpoint.
 * Studio's auth probes (`/api/auth/capabilities`, `/me`, credentials sign-in) stay reachable.
 */
export const MASTRA_ALLOWED_ROUTES: ReadonlyArray<{ methods: readonly string[]; path: RegExp }> = [
  { methods: ['POST'], path: /^\/api\/agents\/ops-lead\/(?:stream|generate)$/ },
  { methods: ['GET', 'POST'], path: /^\/api\/memory\/threads$/ },
  { methods: ['GET', 'PATCH', 'DELETE'], path: /^\/api\/memory\/threads\/[^/]+$/ },
  { methods: ['GET'], path: /^\/api\/memory\/threads\/[^/]+\/messages$/ },
  { methods: ['GET'], path: /^\/api\/\.well-known\/ops-lead\/agent-card\.json$/ },
  { methods: ['POST'], path: /^\/api\/a2a\/ops-lead$/ },
  { methods: ['GET'], path: /^\/api\/auth\/(?:capabilities|me)$/ },
  { methods: ['POST'], path: /^\/api\/auth\/credentials\/sign-in$/ },
];

// Keep the Studio auth paths and the allowlist in step (they are also routed past Better Auth in app.ts).
for (const path of MASTRA_STUDIO_AUTH_PATHS) {
  if (!MASTRA_ALLOWED_ROUTES.some((route) => route.path.test(path))) throw new Error(`Mastra allowlist is missing ${path}`);
}

export function isAllowedMastraRoute(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  return MASTRA_ALLOWED_ROUTES.some((route) => route.methods.includes(verb) && route.path.test(path));
}

export interface MastraAllowlistOptions {
  /**
   * Requests that skip the allowlist. The app passes one only in development: standalone Mastra Studio
   * (`bun run studio`, an STUDIO_ORIGIN origin) needs the full built-in API. Never in production.
   */
  bypass?: (c: Context) => boolean;
}

export function mastraRouteAllowlist(options: MastraAllowlistOptions = {}): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS' || isAllowedMastraRoute(c.req.method, c.req.path) || options.bypass?.(c)) return next();
    return c.json({ error: 'not_found', message: 'Not found' }, 404);
  };
}

/** Development-only Studio bypass: the request's Origin is one of the Studio origins. */
export function studioOriginBypass(studioOrigins: readonly string[]): (c: Context) => boolean {
  const allowed = new Set(studioOrigins);
  return (c) => {
    const origin = c.req.header('origin');
    return origin !== undefined && allowed.has(origin);
  };
}
