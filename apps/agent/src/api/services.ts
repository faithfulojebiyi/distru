import type { SessionResolver, SessionUser } from '../auth/session';
import type {
  Approval,
  AuditEvent,
  DecisionRequest,
  ProposalDetail,
  ProposalSummary,
  RunSummary,
} from './schemas';
import type { z } from 'zod';
import type {
  ListAuditEventsQuerySchema,
  ListProposalsQuerySchema,
  ListRunsQuerySchema,
} from './schemas';

export type DecideResult =
  | { ok: true; proposal: ProposalSummary; approval: Approval }
  | { ok: false; reason: 'not_found' | 'already_decided' };

/** Everything the custom routes depend on. Injected so routes can be tested without a database. */
export type ApiServices = {
  resolveSession: SessionResolver;
  checkDatabase: () => Promise<boolean>;
  proposals: {
    list: (q: z.infer<typeof ListProposalsQuerySchema>) => Promise<ProposalSummary[]>;
    get: (id: string) => Promise<ProposalDetail | null>;
    decide: (id: string, user: SessionUser, input: DecisionRequest) => Promise<DecideResult>;
  };
  audit: {
    list: (q: z.infer<typeof ListAuditEventsQuerySchema>) => Promise<AuditEvent[]>;
  };
  runs: {
    list: (q: z.infer<typeof ListRunsQuerySchema>) => Promise<RunSummary[]>;
  };
};
