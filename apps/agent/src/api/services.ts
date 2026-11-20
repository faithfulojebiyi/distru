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
import type { ContextMemoriesQuerySchema, ContextMemorySchema, ContextProfile, EvalResult, OnboardingReportSchema } from './schemas-insight';
import type { RecallApiService } from '../services/recall';
import type { CreateMcpTokenRequest, LocationList, McpToken, PolicyRule, PolicyRuleInput, PolicyRuleType, ResumeRequest, UndoRequest } from './schemas-ops';

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
  /**
   * POST /api/proposals/{id}/resume (approver): `harness.requestResume` (approve scope, failed only;
   * throws NotResumableError / harness errors), then the same durable executor (`proposal-execute`).
   */
  resume: {
    request: (id: string, user: SessionUser, input: ResumeRequest) => Promise<{ proposal: ProposalDetail; queued: boolean }>;
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
  /** `eval_run` (written by @ops/evals `--sink pg`). */
  evals: {
    latest: () => Promise<EvalResult[]>;
    history: (scenario: string, limit: number) => Promise<EvalResult[]>;
  };
  /** The context layer (packages/context): account profile, learned memories, onboarding report. */
  context: {
    profile: () => Promise<ContextProfile>;
    memories: (q: z.infer<typeof ContextMemoriesQuerySchema>) => Promise<Array<z.infer<typeof ContextMemorySchema>>>;
    onboarding: () => Promise<z.input<typeof OnboardingReportSchema>>;
  };
  /**
   * The Copilot (GET /api/copilot/capabilities): the registry tool names the Ops Lead has right now. Optional: without
   * it the route assumes the full allowlist.
   */
  copilot?: {
    opsLeadTools: () => string[];
  };
  /** Semantic recall (GET /api/recall/search): passages with citations, wrapped as untrusted text. */
  recall: RecallApiService;
  webhooks: {
    /** HMAC secret for `x-distru-signature`. */
    distruSecret: string;
    /** Where `trigger.received` / `trigger.rejected` go (optional: route tests run without it). */
    audit?: AuditSink;
    /**
     * Queues an event (Inngest `send`; `id` is the dedupe key): the trigger's `distru/order.created`
     * (→ restock run) and `distru/record.changed` (→ context sync of that record).
     */
    emit: (event: { name: string; id: string; data: Record<string, unknown> }) => Promise<void>;
  };
};
