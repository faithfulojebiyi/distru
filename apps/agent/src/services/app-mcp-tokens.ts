import { db } from '../db/client';
import { appAuditSink } from '../harness/app';
import { createMcpTokenService, DrizzleMcpTokenStore } from './mcp-tokens';

/** Process-wide MCP token service (Postgres): /mcp auth, /api/mcp-tokens and the A2A token fallback. */
export const appMcpTokens = createMcpTokenService({ store: new DrizzleMcpTokenStore(db), audit: appAuditSink });
