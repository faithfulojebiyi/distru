/**
 * Boundary schemas for the MCP-token, undo, policy-rule and location routes (each top-level schema
 * has `.meta({ id })`, so it is a named component in /api/openapi.json).
 */
import { z } from 'zod';
import { ProposalDetailSchema, ScopeSchema, UndoInfoSchema } from './schemas';

// ── MCP tokens ───────────────────────────────────────────────────────────────────────────────

export const McpTokenSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    /** First characters of the token, to recognise it (the full token is shown only once). */
    prefix: z.string(),
    /** Always includes `read`. */
    scopes: z.array(ScopeSchema),
    createdBy: z.string(),
    createdAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime().nullable(),
    revokedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'McpToken' });

export const McpTokenListSchema = z.object({ items: z.array(McpTokenSchema) }).meta({ id: 'McpTokenList' });

export const CreateMcpTokenRequestSchema = z
  .object({
    /** Who/what uses it, e.g. "Claude Code (Ana's laptop)". */
    name: z.string().trim().min(1).max(100),
    /** Subset of read / propose / approve (read is implied). `approve` lets the client decide proposals it did not create. */
    scopes: z.array(ScopeSchema).min(1).max(3),
  })
  .meta({ id: 'CreateMcpTokenRequest' });

export const CreateMcpTokenResponseSchema = z
  .object({
    /** The plaintext token (`ops_mcp_…`). Shown once: store it in the client's config now. */
    token: z.string(),
    record: McpTokenSchema,
    /** Streamable HTTP endpoint to configure in Claude Code / Codex. */
    mcpUrl: z.string(),
  })
  .meta({ id: 'CreateMcpTokenResponse' });

export const McpTokenIdParamsSchema = z.object({ id: z.uuid() });

// ── Undo ─────────────────────────────────────────────────────────────────────────────────────

export const UndoRequestSchema = z
  .object({
    /** Why the change is being undone (recorded on the undo proposal and in the audit trail). */
    reason: z.string().trim().min(1).max(2000),
    /** Ops of the original proposal to undo; default: every op that can be undone. */
    opIndexes: z.array(z.number().int().nonnegative()).min(1).max(200).optional(),
  })
  .meta({ id: 'UndoRequest' });

export const UndoResponseSchema = z
  .object({
    /** The NEW undo proposal (compensating ops in reverse order); it needs an approver like any change. */
    proposal: ProposalDetailSchema,
  })
  .meta({ id: 'UndoResponse' });

export const UndoUnavailableResponseSchema = z
  .object({ error: z.literal('undo_unavailable'), message: z.string(), undo: UndoInfoSchema })
  .meta({ id: 'UndoUnavailableResponse' });

// ── Resume ───────────────────────────────────────────────────────────────────────────────────

export const ResumeRequestSchema = z
  .object({
    /** Why it is safe to retry now (recorded in the audit trail as `proposal.resume_requested`). */
    reason: z.string().trim().min(1).max(2000).optional(),
  })
  .meta({ id: 'ResumeRequest' });

export const ResumeResponseSchema = z
  .object({
    proposal: ProposalDetailSchema,
    /** False when the queue was unreachable: a pending-execution marker was recorded and the sweeper retries it. */
    queued: z.boolean(),
  })
  .meta({ id: 'ResumeResponse' });

export const NotResumableResponseSchema = z
  .object({ error: z.literal('not_resumable'), message: z.string(), status: z.string() })
  .meta({ id: 'NotResumableResponse' });

// ── Policy rules ─────────────────────────────────────────────────────────────────────────────

export const PolicyRuleSchema = z
  .object({
    key: z.string(),
    params: z.record(z.string(), z.unknown()),
    enabled: z.boolean(),
    description: z.string().nullable(),
    updatedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'PolicyRule' });

export const PolicyRuleTypeSchema = z
  .object({
    key: z.string(),
    description: z.string(),
    /** JSON Schema of the rule's params (from the harness rule definition). */
    paramsSchema: z.record(z.string(), z.unknown()),
  })
  .meta({ id: 'PolicyRuleType' });

export const PolicyRuleListSchema = z
  .object({
    items: z.array(PolicyRuleSchema),
    /** Every rule implementation the engine knows (keys a row may use). */
    available: z.array(PolicyRuleTypeSchema),
  })
  .meta({ id: 'PolicyRuleList' });

export const PolicyRuleInputSchema = z
  .object({
    key: z.string().min(1),
    params: z.record(z.string(), z.unknown()).default({}),
    enabled: z.boolean().default(true),
    description: z.string().max(500).nullable().optional(),
  })
  .meta({ id: 'PolicyRuleInput' });

export const UpdatePolicyRulesRequestSchema = z
  .object({
    /** The complete rule set: rows not listed are deleted. Each key once; params validated against the rule. */
    rules: z.array(PolicyRuleInputSchema).max(50),
  })
  .meta({ id: 'UpdatePolicyRulesRequest' });

export const PolicyValidationErrorSchema = z
  .object({
    error: z.literal('invalid_policy'),
    message: z.string(),
    issues: z.array(z.object({ key: z.string(), message: z.string() })),
  })
  .meta({ id: 'PolicyValidationError' });

// ── Locations ────────────────────────────────────────────────────────────────────────────────

export const LocationSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /** License number(s) / address line when Distru has them. */
    licenseNumber: z.string().nullable(),
    address: z.string().nullable(),
  })
  .meta({ id: 'Location' });

export const LocationListSchema = z
  .object({
    items: z.array(LocationSchema),
    /** When the list was read from Distru (it is cached briefly). */
    fetchedAt: z.iso.datetime(),
  })
  .meta({ id: 'LocationList' });

export type McpToken = z.infer<typeof McpTokenSchema>;
export type CreateMcpTokenRequest = z.infer<typeof CreateMcpTokenRequestSchema>;
export type UndoRequest = z.infer<typeof UndoRequestSchema>;
export type ResumeRequest = z.infer<typeof ResumeRequestSchema>;
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;
export type PolicyRuleInput = z.infer<typeof PolicyRuleInputSchema>;
export type PolicyRuleType = z.infer<typeof PolicyRuleTypeSchema>;
export type Location = z.infer<typeof LocationSchema>;
export type LocationList = z.infer<typeof LocationListSchema>;
