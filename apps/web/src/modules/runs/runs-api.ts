import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';
import { z } from 'zod';

import { getRun, listRuns, startRun } from '../../api/generated/runs/runs';
import type {
  RunDetail,
  RunStatus,
  StartRunRequest,
} from '../../api/generated/opsAgentAPI.schemas';
import { getQueryScope } from '../../lib/query';
import { OPS_LEAD_AGENT_ID, mastraClient } from '../../lib/mastra-client';
import { toast } from '@ops/ui/primitives/toast/toast';
import { useLocationNames } from '../proposals/proposals-api';
import { runLabel } from './run-label';

/** Every run query key, built here so invalidation always matches by prefix. */
export const runKeys = {
  all: (scope: string) => ['runs', scope] as const,
  list: (scope: string) => ['runs', scope, 'list'] as const,
  detail: (scope: string, id: string) => ['runs', scope, 'detail', id] as const,
  locations: (scope: string) => ['runs', scope, 'locations'] as const,
};

/** A run in one of these may still change, so its page polls. */
export const LIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  'running',
  'pending',
  'waiting',
  'suspended',
  'paused',
]);

export const useRuns = () => {
  const client = useQueryClient();
  return useQuery({
    queryKey: runKeys.list(getQueryScope(client)),
    queryFn: ({ signal }) => listRuns({ limit: 100 }, { signal }),
    select: (data) => data.items,
    meta: { suppressErrorToast: true },
    refetchInterval: (query) =>
      query.state.data?.items.some((run) => LIVE_RUN_STATUSES.has(run.status))
        ? 3_000
        : 20_000,
  });
};

/** One run's trace; polls every 2s while it runs or waits for approval. */
export const useRun = (id: string) => {
  const client = useQueryClient();
  return useQuery({
    queryKey: runKeys.detail(getQueryScope(client), id),
    queryFn: ({ signal }) => getRun(id, { signal }),
    meta: { suppressErrorToast: true },
    refetchInterval: (query) => {
      const run: RunDetail | undefined = query.state.data;
      if (!run) return query.state.status === 'error' ? false : 2_000;
      return LIVE_RUN_STATUSES.has(run.status) ? 2_000 : false;
    },
  });
};

/** Queue a restock run, then open its page. */
export const useStartRun = () => {
  const client = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: (body: StartRunRequest) => startRun(body),
    onSuccess: ({ runId }) => {
      toast.success('Restock run started');
      void client.invalidateQueries({ queryKey: runKeys.all(getQueryScope(client)) });
      void navigate({ to: '/runs/$runId', params: { runId } });
    },
  });
};

const InventoryLocationsSchema = z.object({
  rows: z.array(
    z.object({ location: z.object({ id: z.string(), name: z.string() }) }),
  ),
});

export type RunLocation = { id: string; name: string };

/**
 * The locations a run can be scoped to. There is no locations route yet, so this reads them from the
 * Ops Lead's governed, read-only `distru_inventory` tool (Mastra's agent tool route) and keeps the
 * distinct locations. Replace with GET /api/locations when the server has one.
 */
export const useRunLocations = (enabled: boolean) => {
  const client = useQueryClient();
  return useQuery({
    queryKey: runKeys.locations(getQueryScope(client)),
    enabled,
    staleTime: 10 * 60_000,
    meta: { suppressErrorToast: true },
    queryFn: async (): Promise<RunLocation[]> => {
      const result: unknown = await mastraClient
        .getAgent(OPS_LEAD_AGENT_ID)
        .executeTool('distru_inventory', { data: {} });
      const { rows } = InventoryLocationsSchema.parse(result);
      const seen = new Map<string, string>();
      for (const row of rows) seen.set(row.location.id, row.location.name);
      return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
    },
  });
};

/** Labels runs as "Restock · Oakland Warehouse" (scope ids resolved with the cached location list). */
export const useRunLabel = () => {
  const locations = useLocationNames();
  const names = useMemo(() => new Map((locations.data ?? []).map((item) => [item.id, item.name])), [locations.data]);
  return useCallback((run: Parameters<typeof runLabel>[0]) => runLabel(run, names), [names]);
};
