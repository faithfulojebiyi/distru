/**
 * Per-client API tokens for our MCP server (and A2A callers).
 *
 * - Created by an approver (`POST /api/mcp-tokens`); the plaintext `ops_mcp_…` token is returned
 *   once, only its SHA-256 is stored (`mcp_token.token_hash`).
 * - `scopes` ⊆ read / propose / approve (`read` is always included: a client that can propose but
 *   not read its own proposal is useless). Each MCP request authenticates to
 *   `mcpClientPrincipal(tokenId, scopes, name)`; the harness enforces the scopes on every call, and
 *   separation of duties applies (a token cannot approve a proposal it created, nor one its creator
 *   proposed; its creator cannot approve what the token proposed: the principal carries `onBehalfOf`).
 * - Revoking sets `revoked_at`; the token stops working on the next request.
 * - Creation and revocation are audited (`mcp_token.created` / `mcp_token.revoked`).
 */
import { mcpClientPrincipal, ScopeSchema, type AuditEventInput, type AuditSink, type Principal, type Scope } from '@ops/harness';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client';
import { mcpToken } from '../db/schema';

export const MCP_TOKEN_PREFIX = 'ops_mcp_';

export const McpTokenRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(ScopeSchema),
  createdBy: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type McpTokenRecord = z.infer<typeof McpTokenRecordSchema>;

interface StoredToken extends McpTokenRecord {
  tokenHash: string;
}

/** Persistence port (Drizzle in the app, in-memory in tests). */
export interface McpTokenStore {
  insert(row: StoredToken): Promise<void>;
  list(): Promise<McpTokenRecord[]>;
  get(id: string): Promise<McpTokenRecord | null>;
  findByHash(hash: string): Promise<McpTokenRecord | null>;
  revoke(id: string, at: Date): Promise<McpTokenRecord | null>;
  touch(id: string, at: Date): Promise<void>;
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${MCP_TOKEN_PREFIX}${Buffer.from(bytes).toString('base64url')}`;
}

/** Normalised scope set: unique, ordered, always with `read`. */
export function normalizeScopes(scopes: readonly Scope[]): Scope[] {
  const set = new Set<Scope>(['read', ...scopes]);
  return ScopeSchema.options.filter((s) => set.has(s));
}

export const scopeKey = (scopes: readonly Scope[]): string => normalizeScopes(scopes).join('+');

export interface AuthenticatedClient {
  token: McpTokenRecord;
  principal: Principal;
}

export interface McpTokenServiceDeps {
  store: McpTokenStore;
  audit: AuditSink;
  now?: () => Date;
  ids?: () => string;
  /** Don't rewrite `last_used_at` more often than this (ms). Default 60 s. */
  touchEveryMs?: number;
}

export type McpTokenService = ReturnType<typeof createMcpTokenService>;

export function createMcpTokenService(deps: McpTokenServiceDeps) {
  const now = deps.now ?? (() => new Date());
  const ids = deps.ids ?? (() => crypto.randomUUID());
  const touchEvery = deps.touchEveryMs ?? 60_000;
  const actorOf = (user: { id: string; name?: string }) => ({ kind: 'user' as const, id: user.id, scopes: ['read' as const, 'propose' as const, 'approve' as const], ...(user.name ? { label: user.name } : {}) });
  const audit = (event: AuditEventInput) => deps.audit.append({ ...event, id: ids(), at: now().toISOString() });

  return {
    /** Creates a token; the plaintext is in the result and nowhere else. */
    async create(user: { id: string; name?: string }, input: { name: string; scopes: readonly Scope[] }): Promise<{ token: string; record: McpTokenRecord }> {
      const token = generateToken();
      const record: McpTokenRecord = {
        id: ids(),
        name: input.name.trim(),
        prefix: token.slice(0, MCP_TOKEN_PREFIX.length + 6),
        scopes: normalizeScopes(input.scopes),
        createdBy: user.id,
        createdAt: now().toISOString(),
        lastUsedAt: null,
        revokedAt: null,
      };
      await deps.store.insert({ ...record, tokenHash: await hashToken(token) });
      await audit({ type: 'mcp_token.created', actor: actorOf(user), proposalId: null, data: { tokenId: record.id, name: record.name, scopes: record.scopes } });
      return { token, record };
    },

    list: () => deps.store.list(),

    /** Revokes (idempotent: revoking twice keeps the first time). Null when the token doesn't exist. */
    async revoke(user: { id: string; name?: string }, id: string): Promise<McpTokenRecord | null> {
      const existing = await deps.store.get(id);
      if (!existing) return null;
      if (existing.revokedAt) return existing;
      const revoked = await deps.store.revoke(id, now());
      if (revoked) await audit({ type: 'mcp_token.revoked', actor: actorOf(user), proposalId: null, data: { tokenId: id, name: revoked.name } });
      return revoked;
    },

    /** `Authorization: Bearer ops_mcp_…` → principal, or null (unknown, malformed or revoked). */
    async authenticate(token: string | null | undefined): Promise<AuthenticatedClient | null> {
      if (!token || !token.startsWith(MCP_TOKEN_PREFIX) || token.length > 200) return null;
      const record = await deps.store.findByHash(await hashToken(token));
      if (!record || record.revokedAt) return null;
      const at = now();
      if (!record.lastUsedAt || at.getTime() - Date.parse(record.lastUsedAt) > touchEvery) {
        await deps.store.touch(record.id, at).catch(() => undefined);
      }
      // `onBehalfOf`: the approver who minted it, so they cannot approve what their own token proposed (and vice versa).
      return { token: record, principal: mcpClientPrincipal(record.id, record.scopes, `MCP token: ${record.name}`, record.createdBy) };
    },
  };
}

/** `Authorization: Bearer <token>` → token (or null). */
export function bearerOf(header: string | null | undefined): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m?.[1] ?? null;
}

// ── stores ─────────────────────────────────────────────────────────────────────────────────

type Row = typeof mcpToken.$inferSelect;
const toRecord = (r: Row): McpTokenRecord => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  scopes: normalizeScopes(r.scopes),
  createdBy: r.createdBy,
  createdAt: r.createdAt.toISOString(),
  lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  revokedAt: r.revokedAt?.toISOString() ?? null,
});

export class DrizzleMcpTokenStore implements McpTokenStore {
  constructor(private readonly db: DB) {}

  async insert(row: StoredToken): Promise<void> {
    await this.db.insert(mcpToken).values({
      id: row.id,
      name: row.name,
      tokenHash: row.tokenHash,
      prefix: row.prefix,
      scopes: row.scopes,
      createdBy: row.createdBy,
      createdAt: new Date(row.createdAt),
    });
  }

  async list(): Promise<McpTokenRecord[]> {
    return (await this.db.select().from(mcpToken).orderBy(desc(mcpToken.createdAt))).map(toRecord);
  }

  async get(id: string): Promise<McpTokenRecord | null> {
    const [row] = await this.db.select().from(mcpToken).where(eq(mcpToken.id, id));
    return row ? toRecord(row) : null;
  }

  async findByHash(hash: string): Promise<McpTokenRecord | null> {
    const [row] = await this.db.select().from(mcpToken).where(eq(mcpToken.tokenHash, hash));
    return row ? toRecord(row) : null;
  }

  async revoke(id: string, at: Date): Promise<McpTokenRecord | null> {
    const [row] = await this.db.update(mcpToken).set({ revokedAt: at }).where(eq(mcpToken.id, id)).returning();
    return row ? toRecord(row) : null;
  }

  async touch(id: string, at: Date): Promise<void> {
    await this.db.update(mcpToken).set({ lastUsedAt: at }).where(eq(mcpToken.id, id));
  }
}

export class InMemoryMcpTokenStore implements McpTokenStore {
  readonly rows = new Map<string, StoredToken>();
  async insert(row: StoredToken): Promise<void> {
    this.rows.set(row.id, { ...row });
  }
  async list(): Promise<McpTokenRecord[]> {
    return [...this.rows.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(({ tokenHash: _h, ...r }) => r);
  }
  async get(id: string): Promise<McpTokenRecord | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const { tokenHash: _h, ...r } = row;
    return r;
  }
  async findByHash(hash: string): Promise<McpTokenRecord | null> {
    const row = [...this.rows.values()].find((r) => r.tokenHash === hash);
    if (!row) return null;
    const { tokenHash: _h, ...r } = row;
    return r;
  }
  async revoke(id: string, at: Date): Promise<McpTokenRecord | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    row.revokedAt = at.toISOString();
    return this.get(id);
  }
  async touch(id: string, at: Date): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.lastUsedAt = at.toISOString();
  }
}
