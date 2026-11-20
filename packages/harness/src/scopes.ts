import { z } from 'zod';
import { ForbiddenError } from './errors';

export const ScopeSchema = z.enum(['read', 'propose', 'approve']);
export type Scope = z.infer<typeof ScopeSchema>;

export const PrincipalKindSchema = z.enum(['user', 'agent', 'mcp-client']);
export type PrincipalKind = z.infer<typeof PrincipalKindSchema>;

export const PrincipalSchema = z
  .object({
    kind: PrincipalKindSchema,
    id: z.string().min(1),
    scopes: z.array(ScopeSchema),
    label: z.string().optional(),
    /**
     * The human user id this non-human principal acts for (an MCP token → the approver who minted it;
     * an A2A caller → the token's creator). Separation of duties compares the humans behind principals.
     */
    onBehalfOf: z.string().min(1).optional(),
  })
  .refine((p) => !(p.kind === 'agent' && p.scopes.includes('approve')), {
    message: 'Agents can never hold the approve scope',
    path: ['scopes'],
  });
export type Principal = z.infer<typeof PrincipalSchema>;

/** Human roles (mirrors the Better Auth roles in apps/agent). */
export const RoleSchema = z.enum(['operator', 'approver']);
export type Role = z.infer<typeof RoleSchema>;

export const ROLE_SCOPES: Readonly<Record<Role, readonly Scope[]>> = {
  operator: ['read', 'propose'],
  approver: ['read', 'propose', 'approve'],
};

/** The maximum an agent can ever hold. */
export const AGENT_SCOPES: readonly Scope[] = ['read', 'propose'];

export function scopesForRole(role: Role): Scope[] {
  return [...ROLE_SCOPES[role]];
}

/**
 * Agents can never approve, even if a misconfigured principal claims the scope.
 * This is checked here (not only in the schema) so hand-built principals are covered too.
 */
export function hasScope(principal: Principal, scope: Scope): boolean {
  if (scope === 'approve' && principal.kind === 'agent') return false;
  return principal.scopes.includes(scope);
}

export function assertScope(principal: Principal, scope: Scope): void {
  if (!hasScope(principal, scope)) {
    throw new ForbiddenError(`${principal.kind}:${principal.id} lacks the '${scope}' scope`);
  }
}

export function userPrincipal(id: string, role: Role, label?: string): Principal {
  return PrincipalSchema.parse({ kind: 'user', id, scopes: scopesForRole(role), label });
}

export function agentPrincipal(id: string, label?: string): Principal {
  return PrincipalSchema.parse({ kind: 'agent', id, scopes: [...AGENT_SCOPES], label });
}

export function mcpClientPrincipal(id: string, scopes: readonly Scope[], label?: string, onBehalfOf?: string): Principal {
  return PrincipalSchema.parse({ kind: 'mcp-client', id, scopes: [...scopes], label, ...(onBehalfOf ? { onBehalfOf } : {}) });
}

/** The human user behind a principal: a user is themself; others only when they carry `onBehalfOf`. */
export function humanOf(principal: Pick<Principal, 'kind' | 'id' | 'onBehalfOf'>): string | null {
  if (principal.kind === 'user') return principal.id;
  return principal.onBehalfOf ?? null;
}

/**
 * Same actor for separation of duties: the same principal, or two principals backed by the same human
 * (e.g. an approver deciding a proposal their own MCP token created).
 */
export function sameActor(a: Principal, b: Principal): boolean {
  if (a.kind === b.kind && a.id === b.id) return true;
  const human = humanOf(a);
  return human !== null && human === humanOf(b);
}

/** Non-human actor used in audit events for work the harness does itself (e.g. the executor). */
export const SystemActorSchema = z.object({
  kind: z.literal('system'),
  id: z.string().min(1),
  label: z.string().optional(),
});
export type SystemActor = z.infer<typeof SystemActorSchema>;

export const ActorSchema = z.union([PrincipalSchema, SystemActorSchema]);
export type Actor = z.infer<typeof ActorSchema>;

export const EXECUTOR_ACTOR: SystemActor = { kind: 'system', id: 'executor', label: 'Harness executor' };
