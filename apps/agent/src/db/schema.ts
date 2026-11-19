import { sql } from 'drizzle-orm';
import {
  boolean,
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
// ---------------------------------------------------------------------------

export const PROPOSAL_STATUSES = [
  'pending_approval',
  'approved',
  'rejected',
  'executing',
  'executed',
  'failed',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const ACTOR_TYPES = ['user', 'agent', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/** A changeset proposed by an agent run: one or more ERP writes awaiting a human decision. */
export const proposal = pgTable(
  'proposal',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    summary: text('summary'),
    /** Agent reasoning shown on the approval card. */
    reasoning: text('reasoning'),
    status: text('status', { enum: PROPOSAL_STATUSES }).notNull().default('pending_approval'),
    /** Mastra workflow id + run id that produced (and is suspended on) this proposal. */
    workflowId: text('workflow_id'),
    workflowRunId: text('workflow_run_id'),
    createdByType: text('created_by_type', { enum: ACTOR_TYPES }).notNull().default('agent'),
    createdByUserId: text('created_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    /** Policy engine results at proposal time. */
    policyChecks: jsonb('policy_checks').$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    ...timestamps,
  },
  (t) => [
    index('proposal_status_idx').on(t.status),
    index('proposal_workflow_run_idx').on(t.workflowRunId),
  ],
);

export const PROPOSAL_OP_KINDS = ['upsert', 'create', 'update', 'delete'] as const;
export const PROPOSAL_OP_STATUSES = ['pending', 'applied', 'verified', 'failed', 'skipped'] as const;

/** A single ERP write inside a proposal. idempotencyKey is stamped into the Distru record. */
export const proposalOp = pgTable(
  'proposal_op',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposal.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull().default(0),
    resource: text('resource').notNull(),
    op: text('op', { enum: PROPOSAL_OP_KINDS }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    before: jsonb('before').$type<Record<string, unknown> | null>(),
    diff: jsonb('diff').$type<unknown>(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    status: text('status', { enum: PROPOSAL_OP_STATUSES }).notNull().default('pending'),
    result: jsonb('result').$type<unknown>(),
    distruRecordId: text('distru_record_id'),
    ...timestamps,
  },
  (t) => [index('proposal_op_proposal_idx').on(t.proposalId)],
);

export const APPROVAL_DECISIONS = ['approved', 'rejected'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** Exactly one decision per proposal (unique proposal_id), written under a row lock. */
export const approval = pgTable(
  'approval',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposal.id, { onDelete: 'cascade' }),
    decision: text('decision', { enum: APPROVAL_DECISIONS }).notNull(),
    decidedBy: text('decided_by')
      .notNull()
      .references(() => user.id),
    reason: text('reason'),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('approval_proposal_unique').on(t.proposalId)],
);

/** Append-only audit trail for every write and decision. */
export const auditEvent = pgTable(
  'audit_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorType: text('actor_type', { enum: ACTOR_TYPES }).notNull(),
    actorUserId: text('actor_user_id').references(() => user.id, { onDelete: 'set null' }),
    actorAgentId: text('actor_agent_id'),
    action: text('action').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_event_created_idx').on(t.createdAt),
    index('audit_event_subject_idx').on(t.subjectType, t.subjectId),
  ],
);

/** Policy engine configuration (max PO total, vendor allowlist, auto-approve threshold, ...). */
export const policyRule = pgTable('policy_rule', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(),
  value: jsonb('value').$type<unknown>().notNull(),
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
