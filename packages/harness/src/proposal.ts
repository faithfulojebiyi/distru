import { z } from 'zod';
import { RiskSchema } from './action';
import { FieldChangeSchema } from './diff';
import { IllegalTransitionError } from './errors';
import { PolicyEvaluationSchema } from './policy';
import { PrincipalSchema } from './scopes';
import { MismatchSchema } from './verify';

const OutputValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const ProposalStatusSchema = z.enum([
  'draft',
  'pending_approval',
  'auto_approved',
  'denied',
  'approved',
  'rejected',
  'executing',
  'executed',
  'failed',
]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

/**
 * The status machine. `failed -> executing` allows resuming a partially applied proposal; it is
 * safe because every op is idempotent (executed ops are skipped, writes are deduplicated by key).
 */
export const PROPOSAL_TRANSITIONS: Readonly<Record<ProposalStatus, readonly ProposalStatus[]>> = {
  draft: ['pending_approval', 'auto_approved', 'denied'],
  pending_approval: ['approved', 'rejected'],
  auto_approved: ['executing'],
  approved: ['executing'],
  executing: ['executed', 'failed'],
  failed: ['executing'],
  denied: [],
  rejected: [],
  executed: [],
};

export function canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  return PROPOSAL_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ProposalStatus, to: ProposalStatus): ProposalStatus {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  return to;
}

export const SerializedErrorSchema = z.object({
  name: z.string(),
  message: z.string(),
  code: z.string().optional(),
});
export type SerializedError = z.infer<typeof SerializedErrorSchema>;

export const OpStatusSchema = z.enum(['pending', 'executed', 'failed']);
export type OpStatus = z.infer<typeof OpStatusSchema>;

export const OpResultSchema = z.object({
  recordId: z.string().nullable(),
  /** True when the write was found already applied (via idempotency key) and skipped. */
  deduplicated: z.boolean(),
  attempts: z.number().int(),
  mismatches: z.array(MismatchSchema),
  error: SerializedErrorSchema.nullable(),
  finishedAt: z.string(),
  /** Values this op's record exports to later ops (`{{op:<index>.<key>}}`), from the action's `outputs` hook. */
  outputs: z.record(z.string(), OutputValueSchema).optional(),
  /** Op references substituted into this op's payload at execute time (placeholder → value). */
  resolved: z.record(z.string(), OutputValueSchema).optional(),
});
export type OpResult = z.infer<typeof OpResultSchema>;

export const ProposalOpSchema = z.object({
  index: z.number().int().nonnegative(),
  action: z.string(),
  resource: z.string(),
  risk: RiskSchema,
  input: z.unknown(),
  before: z.unknown(),
  /** Exact request body that will be sent. */
  payload: z.unknown(),
  diff: z.array(FieldChangeSchema),
  summary: z.string().nullable(),
  value: z.number().nullable(),
  vendorIds: z.array(z.string()).nullable(),
  idempotencyKey: z.string(),
  status: OpStatusSchema,
  result: OpResultSchema.nullable(),
});
export type ProposalOp = z.infer<typeof ProposalOpSchema>;

export const DecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  by: PrincipalSchema,
  reason: z.string().nullable(),
  edited: z.boolean(),
  at: z.string(),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const ProposalSchema = z.object({
  id: z.string(),
  /** Optimistic-concurrency version; incremented on every write. */
  version: z.number().int().nonnegative(),
  status: ProposalStatusSchema,
  /** Short human headline (≤ 120 chars, single line; apps aim for ≤ 60). */
  title: z.string().nullable(),
  /** One or two sentences with the detail the title leaves out (totals, counts, vendors). */
  summary: z.string().nullable().optional(),
  rationale: z.string().nullable(),
  meta: z.record(z.string(), z.unknown()),
  createdBy: PrincipalSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  ops: z.array(ProposalOpSchema),
  policy: PolicyEvaluationSchema,
  decision: DecisionSchema.nullable(),
  execution: z
    .object({
      startedAt: z.string().nullable(),
      finishedAt: z.string().nullable(),
      error: SerializedErrorSchema.nullable(),
    })
    .nullable(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export function totalValue(ops: readonly Pick<ProposalOp, 'value'>[]): number | null {
  let total = 0;
  for (const op of ops) {
    if (op.value === null) return null;
    total += op.value;
  }
  return total;
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const code = 'code' in err && typeof err.code === 'string' ? err.code : undefined;
    return { name: err.name, message: err.message, ...(code ? { code } : {}) };
  }
  return { name: 'Error', message: String(err) };
}

/** Hard limits on proposal headlines (the harness rejects longer ones; it never truncates). */
export const TITLE_MAX_CHARS = 120;
export const SUMMARY_MAX_CHARS = 1000;
