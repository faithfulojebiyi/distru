import { sql } from 'drizzle-orm';
import {
  DecisionSchema,
  OpStatusSchema,
  PolicyOutcomeSchema,
  PrincipalKindSchema,
  ProposalStatusSchema,
  RiskSchema,
  type Actor,
  type FieldChange,
  type OpResult,
  type PolicyEvaluation,
  type Principal,
  type Proposal,
} from '@ops/harness';
import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/*
 * App tables live in the `public` schema. Mastra's own tables (runs, traces, memory) live in the
 * `mastra` schema via PostgresStore({ schemaName: 'mastra' }), so drizzle-kit never touches them.
 */

export const USER_ROLES = ['operator', 'approver'] as const;
export type UserRole = (typeof USER_ROLES)[number];

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

// ---------------------------------------------------------------------------
// Better Auth core tables (user / session / account / verification)
// ---------------------------------------------------------------------------

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  role: text('role', { enum: USER_ROLES }).notNull().default('operator'),
  ...timestamps,
});

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (t) => [index('session_user_id_idx').on(t.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    ...timestamps,
  },
  (t) => [index('account_user_id_idx').on(t.userId)],
);

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

// ---------------------------------------------------------------------------
// Ops Agent domain tables
//
// These persist the @ops/harness model (packages/harness). The column set is chosen so a harness
// `Proposal` round-trips exactly through `proposal` + `proposal_op` + `approval`
// (see src/harness/proposal-store.ts). Enum values come from the harness schemas so the two can't
// drift apart.
// ---------------------------------------------------------------------------

/** zod enum options → the non-empty tuple Drizzle's `text({ enum })` wants (checked, no cast). */
function nonEmpty<T extends string>(values: readonly T[]): [T, ...T[]] {
  const [first, ...rest] = values;
  if (first === undefined) throw new Error('enum must have at least one value');
  return [first, ...rest];
}

export const PROPOSAL_STATUSES = nonEmpty(ProposalStatusSchema.options);
export const PRINCIPAL_KINDS = nonEmpty(PrincipalKindSchema.options);
/** Audit actors are principals plus the harness's own `system` actor (the executor). */
export const ACTOR_KINDS = nonEmpty([...PrincipalKindSchema.options, 'system' as const]);
export const OP_STATUSES = nonEmpty(OpStatusSchema.options);
export const RISKS = nonEmpty(RiskSchema.options);
export const POLICY_OUTCOMES = nonEmpty(PolicyOutcomeSchema.options);
export const DECISIONS = nonEmpty(DecisionSchema.shape.decision.options);

/**
 * A changeset proposed by an agent (or user / MCP client): one or more ERP writes, gated by policy.
 * `version` is the optimistic-concurrency token: every harness write is
 * `UPDATE proposal SET ..., version = version + 1 WHERE id = $1 AND version = $2`.
 */
export const proposal = pgTable(
  'proposal',
  {
    id: uuid('id').primaryKey(),
    version: integer('version').notNull(),
    status: text('status', { enum: PROPOSAL_STATUSES }).notNull(),
    title: text('title'),
    /** Agent reasoning shown on the approval card. */
    rationale: text('rationale'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** Full harness Principal; kind/id are denormalised for filtering. */
    createdBy: jsonb('created_by').$type<Principal>().notNull(),
    createdByKind: text('created_by_kind', { enum: PRINCIPAL_KINDS }).notNull(),
    createdById: text('created_by_id').notNull(),
    /** Policy engine result (outcome + reasons); outcome denormalised for filtering. */
    policy: jsonb('policy').$type<PolicyEvaluation>().notNull(),
    policyOutcome: text('policy_outcome', { enum: POLICY_OUTCOMES }).notNull(),
    /** Sum of op values (null when any op cannot be valued). Denormalised for lists. */
    totalValue: doublePrecision('total_value'),
    execution: jsonb('execution').$type<Proposal['execution']>(),
    /** Mastra workflow id + run id that produced (and is suspended on) this proposal, from `meta`. */
    workflowId: text('workflow_id'),
    workflowRunId: text('workflow_run_id'),
    /** Harness timestamps (not DB defaults) so the stored proposal round-trips exactly. */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('proposal_status_idx').on(t.status),
    index('proposal_created_idx').on(t.createdAt),
    index('proposal_workflow_run_idx').on(t.workflowRunId),
  ],
);

/** A single ERP write inside a proposal. `idempotency_key` is stamped into the Distru record. */
export const proposalOp = pgTable(
  'proposal_op',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposal.id, { onDelete: 'cascade' }),
    opIndex: integer('op_index').notNull(),
    action: text('action').notNull(),
    resource: text('resource').notNull(),
    risk: text('risk', { enum: RISKS }).notNull(),
    /** Validated agent input, record before the write, exact request body, field-level diff. */
    input: jsonb('input').$type<unknown>(),
    before: jsonb('before').$type<unknown>(),
    payload: jsonb('payload').$type<unknown>(),
    diff: jsonb('diff').$type<FieldChange[]>().notNull(),
    summary: text('summary'),
    value: doublePrecision('value'),
    vendorIds: jsonb('vendor_ids').$type<string[] | null>(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    status: text('status', { enum: OP_STATUSES }).notNull(),
    result: jsonb('result').$type<OpResult | null>(),
    /** Denormalised from `result` for queries. */
    attempts: integer('attempts').notNull().default(0),
    recordId: text('record_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('proposal_op_index_unique').on(t.proposalId, t.opIndex)],
);

/**
 * The decision record: exactly one per proposal (unique proposal_id). Written by the proposal store
 * in the same transaction as the `pending_approval -> approved | rejected` compare-and-set.
 * `decided_by_id` is a principal id (a user id for UI decisions, a client id for MCP), so no FK.
 */
export const approval = pgTable(
  'approval',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposal.id, { onDelete: 'cascade' }),
    decision: text('decision', { enum: DECISIONS }).notNull(),
    decidedBy: jsonb('decided_by').$type<Principal>().notNull(),
    decidedByKind: text('decided_by_kind', { enum: PRINCIPAL_KINDS }).notNull(),
    decidedById: text('decided_by_id').notNull(),
    reason: text('reason'),
    edited: boolean('edited').notNull().default(false),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('approval_proposal_unique').on(t.proposalId)],
);

/**
 * Append-only audit trail (harness `AuditEvent` union). Common fields are columns; the
 * type-specific payload is `data`. `seq` gives a total insertion order (timestamps can tie).
 * No FK to proposal: the trail outlives anything it describes.
 */
export const auditEvent = pgTable(
  'audit_event',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    id: uuid('id').notNull().unique(),
    type: text('type').notNull(),
    actor: jsonb('actor').$type<Actor>().notNull(),
    actorKind: text('actor_kind', { enum: ACTOR_KINDS }).notNull(),
    actorId: text('actor_id').notNull(),
    proposalId: uuid('proposal_id'),
    opIndex: integer('op_index'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('audit_event_at_idx').on(t.at),
    index('audit_event_proposal_idx').on(t.proposalId, t.seq),
    index('audit_event_type_idx').on(t.type),
  ],
);

/** Policy rule configs (harness `PolicyRuleConfig`): built-in rule key + params, toggled by `enabled`. */
export const policyRule = pgTable('policy_rule', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(),
  params: jsonb('params').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  enabled: boolean('enabled').notNull().default(true),
  description: text('description'),
  ...timestamps,
});

/** One row per scenario per eval run. */
export const evalRun = pgTable(
  'eval_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: text('batch_id'),
    scenario: text('scenario').notNull(),
    scores: jsonb('scores').$type<Record<string, number>>().notNull(),
    passed: boolean('passed').notNull(),
    details: jsonb('details').$type<unknown>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('eval_run_scenario_idx').on(t.scenario, t.createdAt)],
);
