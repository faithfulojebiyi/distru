import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';

import { ApiError, apiErrorMessage } from '../../api/errors';
import { listAuditEvents } from '../../api/generated/audit/audit';
import { listLocations } from '../../api/generated/distru/distru';
import {
  decideProposal,
  getProposal,
  listProposals,
  resumeProposal,
  undoProposal,
} from '../../api/generated/proposals/proposals';
import type {
  DecisionRequest,
  ListAuditEventsParams,
  PolicyEvaluation,
  ProposalDetail,
  UndoRequest,
} from '../../api/generated/opsAgentAPI.schemas';
import { getQueryScope } from '../../lib/query';
import { toast } from '@ops/ui/primitives/toast/toast';
import { LIVE_STATUSES } from './proposal-values';

/** Every proposal and audit query key, built here so invalidation always matches by prefix. */
export const proposalKeys = {
  all: (scope: string) => ['proposals', scope] as const,
  list: (scope: string) => ['proposals', scope, 'list'] as const,
  detail: (scope: string, id: string) =>
    ['proposals', scope, 'detail', id] as const,
};

export const auditKeys = {
  all: (scope: string) => ['audit', scope] as const,
  list: (scope: string, params: ListAuditEventsParams) =>
    ['audit', scope, 'list', params] as const,
};

/** The inbox and overview both read one list (newest 200) and filter on the client, so tab counts are exact. */
export const PROPOSAL_LIST_LIMIT = 200;

export const useProposals = () => {
  const client = useQueryClient();
  return useQuery({
    queryKey: proposalKeys.list(getQueryScope(client)),
    queryFn: ({ signal }) =>
      listProposals({ limit: PROPOSAL_LIST_LIMIT }, { signal }),
    select: (data) => data.items,
    // The screens render their own error state.
    meta: { suppressErrorToast: true },
    refetchInterval: 20_000,
  });
};

/** How long after its last change an approved proposal keeps polling for the executor. */
const LIVE_WINDOW_MS = 10 * 60_000;

const isLive = (proposal: ProposalDetail | undefined) =>
  Boolean(
    proposal &&
      LIVE_STATUSES.includes(proposal.status) &&
      (proposal.status === 'executing' ||
        Date.now() - new Date(proposal.updatedAt).getTime() < LIVE_WINDOW_MS),
  );

/** One proposal; polls every 2s while the executor may still move it (approved → executing → executed). */
export const useProposal = (id: string) => {
  const client = useQueryClient();
  return useQuery({
    queryKey: proposalKeys.detail(getQueryScope(client), id),
    queryFn: ({ signal }) => getProposal(id, { signal }),
    meta: { suppressErrorToast: true },
    refetchInterval: (query) => (isLive(query.state.data) ? 2_000 : false),
  });
};

export const useAuditEvents = (
  params: ListAuditEventsParams,
  options: { live?: boolean } = {},
) => {
  const client = useQueryClient();
  return useQuery({
    queryKey: auditKeys.list(getQueryScope(client), params),
    queryFn: ({ signal }) => listAuditEvents(params, { signal }),
    select: (data) => data.items,
    meta: { suppressErrorToast: true },
    refetchInterval: options.live ? 2_000 : 30_000,
  });
};

/** What went wrong with a decision, in the shape the decision panel renders. */
export type DecisionFailure =
  | { kind: 'policy_denied'; message: string; evaluation: PolicyEvaluation }
  | { kind: 'conflict'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'other'; message: string };

const isEvaluation = (value: unknown): value is PolicyEvaluation =>
  Boolean(
    value &&
      typeof value === 'object' &&
      'outcome' in value &&
      'reasons' in value &&
      Array.isArray(value.reasons),
  );

export const decisionFailureOf = (error: unknown): DecisionFailure => {
  const message = apiErrorMessage(error);
  if (!(error instanceof ApiError)) return { kind: 'other', message };
  const body =
    error.body && typeof error.body === 'object'
      ? (error.body as Record<string, unknown>)
      : {};
  if (error.status === 403)
    return {
      kind: 'forbidden',
      message:
        typeof body.message === 'string'
          ? body.message
          : 'Only approvers can decide proposals.',
    };
  if (error.status === 409 && body.error === 'policy_denied' && isEvaluation(body.evaluation))
    return { kind: 'policy_denied', message, evaluation: body.evaluation };
  if (error.status === 409)
    return {
      kind: 'conflict',
      message:
        body.error === 'concurrent_modification'
          ? 'Someone changed this proposal while you were deciding. The latest version is loaded; check it and decide again.'
          : 'This proposal was already decided. The latest status is loaded.',
    };
  return { kind: 'other', message };
};

const invalidateProposals = (client: QueryClient) => {
  const scope = getQueryScope(client);
  return Promise.all([
    client.invalidateQueries({ queryKey: proposalKeys.all(scope) }),
    client.invalidateQueries({ queryKey: auditKeys.all(scope) }),
  ]);
};

/**
 * Approve or reject. The new proposal goes straight into the detail cache; the list and audit
 * trail refetch. A conflict refetches too, so the page shows whoever decided first.
 */
export const useDecideProposal = (id: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: DecisionRequest) => decideProposal(id, body),
    onSuccess: ({ proposal }, body) => {
      client.setQueryData(
        proposalKeys.detail(getQueryScope(client), id),
        proposal,
      );
      toast.success(
        body.decision === 'approve' ? 'Proposal approved' : 'Proposal rejected',
      );
      void invalidateProposals(client);
    },
    // The panel shows the failure inline; a conflict means the cache is stale.
    onError: (error) => {
      const failure = decisionFailureOf(error);
      if (failure.kind === 'conflict') {
        toast.warning(failure.message);
        void invalidateProposals(client);
      }
      if (failure.kind === 'other') toast.error(failure.message);
    },
  });
};

/**
 * Propose undoing an executed proposal: the server answers with a NEW pending proposal of compensating ops,
 * which still needs an approver. The caller navigates to it; the original refetches so its undo block shows
 * the link.
 */
export const useUndoProposal = (id: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: UndoRequest) => undoProposal(id, body),
    onSuccess: ({ proposal }) => {
      client.setQueryData(proposalKeys.detail(getQueryScope(client), proposal.id), proposal);
      toast.success('Undo proposed. It needs an approver before anything changes.');
      void invalidateProposals(client);
    },
    // The form shows the failure inline.
    onError: () => undefined,
  });
};

/** The undo route's refusal (409 `undo_unavailable`, or 400 when a record moved on), as one line. */
export const undoFailureOf = (error: unknown): string => {
  if (error instanceof ApiError && error.body && typeof error.body === 'object') {
    const body = error.body as { message?: unknown; undo?: { reason?: unknown } };
    if (typeof body.undo?.reason === 'string' && body.undo.reason) return body.undo.reason;
    if (typeof body.message === 'string' && body.message) return body.message;
  }
  return apiErrorMessage(error);
};

/** Resume a failed proposal from the first op that did not finish (`POST /api/proposals/:id/resume`). */
export const useResumeProposal = (id: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => resumeProposal(id, {}),
    onSuccess: (result) => {
      client.setQueryData(proposalKeys.detail(getQueryScope(client), id), result.proposal);
      toast.success('Resuming. The executor picks up from the op that failed.');
      void invalidateProposals(client);
    },
    // The form shows the failure inline.
    onError: () => undefined,
  });
};

/** Own Distru locations (cached 5 min on the server), so a diff can show "Oakland Warehouse" for a location id. */
export const useLocationNames = () => {
  const client = useQueryClient();
  return useQuery({
    queryKey: ['locations', getQueryScope(client)] as const,
    queryFn: ({ signal }) => listLocations({ signal }),
    select: (data) => data.items.map((item) => ({ id: item.id, name: item.name })),
    staleTime: 10 * 60_000,
    meta: { suppressErrorToast: true },
  });
};
