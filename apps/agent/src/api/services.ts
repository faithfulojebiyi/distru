import type { z } from 'zod';
import type { SessionResolver, SessionUser } from '../auth/session';
import type {
  AuditEvent,
  DecisionRequest,
  ListAuditEventsQuerySchema,
  ListProposalsQuerySchema,
  ListRunsQuerySchema,
  ProposalDetail,
  ProposalSummary,
  RunSummary,
} from './schemas';

/** Everything the custom routes depend on. Injected so routes can be tested without a database. */
export type ApiServices = {
  resolveSession: SessionResolver;
  checkDatabase: () => Promise<boolean>;
  proposals: {
    list: (q: z.infer<typeof ListProposalsQuerySchema>) => Promise<ProposalSummary[]>;
    get: (id: string) => Promise<ProposalDetail | null>;
    /**
     * Records the decision through `harness.decide`. Throws harness errors (ForbiddenError,
     * NotFoundError, DecisionConflictError, ConcurrentModificationError, PolicyDeniedError,
     * InputValidationError); the route maps them to HTTP status codes.
     */
    decide: (id: string, user: SessionUser, input: DecisionRequest) => Promise<ProposalDetail>;
  };
  audit: {
    list: (q: z.infer<typeof ListAuditEventsQuerySchema>) => Promise<AuditEvent[]>;
  };
  runs: {
    list: (q: z.infer<typeof ListRunsQuerySchema>) => Promise<RunSummary[]>;
  };
};
