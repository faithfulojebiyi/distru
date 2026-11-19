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
  webhooks: {
    /** HMAC secret for `x-distru-signature`. */
    distruSecret: string;
    /** Emits the event that starts a restock run (Inngest `ops/restock.requested`). */
    requestRestock: (trigger: { triggeredBy: string; productIds?: string[]; locationIds?: string[]; scenarioNote?: string }) => Promise<void>;
  };
};
