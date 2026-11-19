import { MastraClient } from '@mastra/client-js';

import { apiUrl } from '../config/api-url';

/**
 * Mastra's own routes (/api/agents, /api/memory, …) are not in our OpenAPI document, so Orval cannot
 * generate them; the official client calls them instead. `credentials: 'include'` sends the Better Auth
 * session cookie cross-origin, and the server maps the signed-in user to the memory resource.
 */
export const mastraClient = new MastraClient({
  baseUrl: apiUrl,
  credentials: 'include',
});

/** The supervisor the Copilot talks to. */
export const OPS_LEAD_AGENT_ID = 'ops-lead';
