import type { AuditSink, Principal } from '@ops/harness';
import type { z } from 'zod';
import type { SessionResolver, SessionUser } from '../auth/session';
import type {
  AuditEvent,
  ConnectorSummary,
  DecisionRequest,
  ListAuditEventsQuerySchema,
  ListProposalsQuerySchema,
  ListRunsQuerySchema,
  ProposalDetail,
  ProposalSummary,
  RunDetail,
  RunSummary,
  StartRunRequest,
} from './schemas';
import type { CreateMcpTokenRequest, LocationList, McpToken, PolicyRule, PolicyRuleInput, PolicyRuleType, UndoRequest } from './schemas-ops';

/** Everything the custom routes depend on. Injected so routes can be tested without a database. */
export type ApiServices = {
  resolveSession: SessionResolver;
  checkDatabase: () => Promise<boolean>;
  proposals: {
    list: (q: z.infer<typeof ListProposalsQuerySchema>) => Promise<ProposalSummary[]>;
    get: (id: string) => Promise<ProposalDetail | null>;
    /**
     * Records the decision through `harness.decide`, then resumes the workflow run that created the
     * proposal (if it is suspended). Throws harness errors (ForbiddenError, NotFoundError,
     * DecisionConflictError, ConcurrentModificationError, PolicyDeniedError, InputValidationError);
     * the route maps them to HTTP status codes.
     */
    decide: (id: string, user: SessionUser, input: DecisionRequest) => Promise<ProposalDetail>;
  };
  audit: {
    list: (q: z.infer<typeof ListAuditEventsQuerySchema>) => Promise<AuditEvent[]>;
  };
  runs: {
    list: (q: z.infer<typeof ListRunsQuerySchema>) => Promise<RunSummary[]>;
    get: (runId: string) => Promise<RunDetail | null>;
    /** Starts a restock run; returns as soon as the run is queued. */
    start: (input: StartRunRequest, user: SessionUser) => Promise<{ runId: string; workflowId: string }>;
  };
  connectors: {
    list: () => Promise<ConnectorSummary[]>;
  };
  /** POST /api/proposals/{id}/undo → harness.undo (a new compensating proposal; throws harness errors / UndoUnavailableError). */
  undo: {
    propose: (id: string, user: SessionUser, input: UndoRequest) => Promise<ProposalDetail>;
  };
  /** Per-client MCP tokens (approver only). */
  mcpTokens: {
    create: (user: SessionUser, input: CreateMcpTokenRequest) => Promise<{ token: string; record: McpToken }>;
    list: () => Promise<McpToken[]>;
    /** Null when the token does not exist. */
    revoke: (user: SessionUser, id: string) => Promise<McpToken | null>;
    /** Public URL of the MCP endpoint (for the create response). */
    mcpUrl: string;
  };
  /** Policy rules (`policy_rule`); `replace` validates against the engine's rules (PolicyValidationError) and audits `policy.changed`. */
  policyRules: {
    list: () => Promise<PolicyRule[]>;
    available: () => PolicyRuleType[];
    replace: (actor: Principal, rules: PolicyRuleInput[]) => Promise<PolicyRule[]>;
  };
  locations: {
    list: () => Promise<LocationList>;
  };
  webhooks: {
    /** HMAC secret for `x-distru-signature`. */
    distruSecret: string;
    /** Where `trigger.received` / `trigger.rejected` go (optional: route tests run without it). */
    audit?: AuditSink;
    /** Emits the event that starts a restock run (Inngest `ops/restock.requested`). */
    requestRestock: (trigger: { triggeredBy: string; productIds?: string[]; locationIds?: string[]; scenarioNote?: string }) => Promise<void>;
  };
};
