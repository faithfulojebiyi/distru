import type { Mastra } from '@mastra/core';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';

/** Path of Mastra's built-in A2A agent card (v0.3 and v1 share it). */
export const A2A_CARD_PATH = '/api/.well-known/:agentId/agent-card.json';

const CardSchema = z.object({ description: z.string().optional() }).passthrough();

/**
 * Mastra 1.85 builds the A2A agent card's `description` from the agent's full instructions, which
 * would publish the Ops Lead's system prompt (method, safety rules) to every A2A client. This
 * middleware, mounted before MastraServer on the card path, replaces it with the agent's short public
 * `description`. The card stays behind the same auth; skills (tool descriptions) are unchanged.
 */
export function publicAgentCard(mastra: Pick<Mastra, 'getAgentById'>): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.res.status !== 200) return;
    const agentId = c.req.param('agentId');
    let description: string | undefined;
    try {
      description = agentId ? mastra.getAgentById(agentId).getDescription() : undefined;
    } catch {
      description = undefined;
    }
    const parsed = CardSchema.safeParse(await c.res.clone().json().catch(() => null));
    if (!parsed.success) return;
    const card = { ...parsed.data, description: description || 'Ops Agent' };
    const headers = new Headers(c.res.headers);
    headers.delete('content-length');
    c.res = new Response(JSON.stringify(card), { status: 200, headers });
  };
}
