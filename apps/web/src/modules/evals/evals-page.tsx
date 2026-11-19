// The Evals page: the latest result per scenario as carbonme apps/admin/src/modules/customers/customers-page.tsx's
// hairline table (lineTableStyles, from carbonme apps/admin/src/ui/table.tsx), the figures above it as carbonme
// apps/admin/src/ui/stat-card.tsx, and each scenario's history in the audit log's SideDrawer (carbonme
// apps/admin/src/ui/side-drawer.tsx with DrawerFact). Empty state: carbonme integrations/integration-empty-state.tsx.
import { useState } from 'react';
import { css, cx } from '@ops/ui/css';
import { Box, Flex, Grid, HStack, styled } from '@ops/ui/jsx';

import { Skeleton } from '@ops/ui/primitives/skeleton';
import { Span } from '@ops/ui/primitives/text';
import { isRouteMissingError } from '../../api/errors';
import { Page } from '../layout/components/page';
import { Pill, TONES } from '../proposals/components/badges';
import { formatAge, formatDateTime } from '../proposals/proposal-values';
import { formatCost, formatTokens } from '../steps/step-activity-data';
import { lineTableStyles as t } from '../system/components/admin-table';
import { DrawerFact, SideDrawer } from '../system/components/side-drawer';
import { EmptyState, ErrorState } from '../system/components/states';
import { StatCard } from '../system/components/stat-card';
import { useNow } from '../system/use-now';
import { evalFacts, useEvalHistory, useEvalRuns, type EvalRun } from './evals-api';

const Command = ({ children }: { children: string }) => (
  <styled.code fontFamily="mono" fontSize="1" px="1.5" py="0.5" rounded="sm" bg="brand.panel.5">
    {children}
  </styled.code>
);

const RunHint = () => (
  <Span color="text.muted" fontSize="1.5">
    Run <Command>bun run evals</Command> (offline, replays recordings for free) or <Command>bun run evals:live</Command>{' '}
    from the repo root. Results land in the <Command>eval_run</Command> table and show here.
  </Span>
);

const Result = ({ run }: { run: EvalRun }) => {
  const facts = evalFacts(run);
  if (facts.status === 'error') return <Pill tone={TONES.bad} label="Error" />;
  return run.passed ? <Pill tone={TONES.good} label="Pass" data-eval-result="pass" /> : <Pill tone={TONES.bad} label="Fail" data-eval-result="fail" />;
};

const sha = (value: string | null) => (value ? value.slice(0, 7) : '—');

/** One scenario's runs, newest first, in the audit log's drawer. */
const HistoryDrawer = ({ scenario, onClose }: { scenario: string | null; onClose: () => void }) => {
  const history = useEvalHistory(scenario);
  const runs = scenario ? (history.data ?? []) : null;
  const latest = runs?.[0];
  const facts = latest ? evalFacts(latest) : null;
  return (
    <SideDrawer
      open={scenario !== null}
      onClose={onClose}
      title={facts?.title ?? 'Scenario'}
      description={latest ? `${latest.scenario} · ${runs?.length ?? 0} run${runs?.length === 1 ? '' : 's'}` : null}
      data-eval-drawer=""
    >
      <Flex direction="column" gap="2">
        {history.isPending && scenario ? <Skeleton h="24" rounded="lg" /> : null}
        {history.isError ? (
          <Span color="text.muted" fontSize="1.5">
            Could not load this scenario’s history.
          </Span>
        ) : null}
        {(runs ?? []).map((run) => {
          const f = evalFacts(run);
          return (
            <Flex key={run.id} direction="column" gap="2.5" p="3" rounded="lg" bg="brand.panel.3" data-eval-run={run.id}>
              <HStack justify="space-between" gap="2">
                <HStack gap="2">
                  <Result run={run} />
                  <Span fontSize="1.5" fontWeight="500">
                    {formatDateTime(run.createdAt)}
                  </Span>
                </HStack>
                <Span color="text.muted" fontSize="1">
                  {f.mode ?? ''}
                </Span>
              </HStack>
              <dl className={css({ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '3' })}>
                <DrawerFact label="Assertions">{f.assertions ? `${f.assertions.passed} of ${f.assertions.total}` : '—'}</DrawerFact>
                <DrawerFact label="Cost">{f.costUsd !== null ? formatCost(f.costUsd) : '—'}</DrawerFact>
                <DrawerFact label="Tokens">{f.tokens !== null ? formatTokens(f.tokens) : '—'}</DrawerFact>
                <DrawerFact label="Model">{f.model ?? '—'}</DrawerFact>
                <DrawerFact label="Git sha">
                  <styled.code fontFamily="mono">{sha(f.gitSha)}</styled.code>
                </DrawerFact>
                <DrawerFact label="Judge">{f.judge !== null ? f.judge.toFixed(2) : '—'}</DrawerFact>
              </dl>
              {f.reason ? (
                <Span color={run.passed ? 'text.muted' : 'text.error'} fontSize="1.5">
                  {f.reason}
                </Span>
              ) : null}
            </Flex>
          );
        })}
      </Flex>
    </SideDrawer>
  );
};

const HEADERS = ['Scenario', 'Result', 'Assertions', 'Cost', 'Tokens', 'Model', 'Git sha', 'When'];

/** Evals: the newest result per scenario, overall figures, and each scenario's history. */
export const EvalsPage = () => {
  const runs = useEvalRuns();
  const now = useNow(60_000);
  const [open, setOpen] = useState<string | null>(null);

  const latest = runs.data ?? [];
  const passing = latest.filter((run) => run.passed).length;
  const lastBatch = latest.reduce<EvalRun | null>((top, run) => (!top || run.createdAt > top.createdAt ? run : top), null);
  const batchCost = latest
    .filter((run) => lastBatch?.batchId && run.batchId === lastBatch.batchId)
    .reduce((total, run) => total + (evalFacts(run).costUsd ?? 0), 0);

  return (
    <Page title="Evals" description="Scenario scores for the agent system: the latest result per scenario, with history." width="wide">
      {runs.isPending ? (
        <Flex direction="column" gap="3">
          <Grid gridTemplateColumns="repeat(3, minmax(0, 1fr))" gap="3">
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} h="5.5rem" rounded="xl" />
            ))}
          </Grid>
          <Skeleton h="64" rounded="xl" />
        </Flex>
      ) : runs.isError ? (
        isRouteMissingError(runs.error) ? (
          <EmptyState
            illustration="reports"
            title="Evals aren’t available on this server yet"
            hint="This agent server doesn’t serve GET /api/evals. Once it does, the latest result per scenario shows here."
            action={<RunHint />}
          />
        ) : (
          <ErrorState title="Could not load eval results" error={runs.error} retry={() => void runs.refetch()} />
        )
      ) : latest.length === 0 ? (
        <EmptyState illustration="reports" title="No eval runs yet" hint="Each scenario’s newest result and its history show here." action={<RunHint />} />
      ) : (
        <Flex direction="column" gap="5">
          <Grid gridTemplateColumns={{ base: '1fr 1fr', md: 'repeat(3, minmax(0, 1fr))' }} gap="3">
            <StatCard label="Scenarios passing" value={`${passing} of ${latest.length}`} tone={passing < latest.length ? 'bad' : undefined} note="Latest run of each" />
            <StatCard label="Last run" value={lastBatch ? formatAge(lastBatch.createdAt, now) : '—'} note={lastBatch ? `sha ${sha(evalFacts(lastBatch).gitSha)} · ${evalFacts(lastBatch).model ?? 'model n/a'}` : undefined} />
            <StatCard label="Last batch cost" value={formatCost(batchCost)} note={lastBatch ? (evalFacts(lastBatch).mode ?? undefined) : undefined} />
          </Grid>
          <Box className={t.panel}>
            <table className={t.table} data-testid="evals-table">
              <thead>
                <tr>
                  {HEADERS.map((header) => (
                    <th key={header} className={['Cost', 'Tokens'].includes(header) ? t.thNumber : t.th}>
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {latest.map((run) => {
                  const f = evalFacts(run);
                  return (
                    <tr
                      key={run.scenario}
                      className={cx(t.row, css({ cursor: 'pointer' }))}
                      onClick={() => setOpen(run.scenario)}
                      data-eval-scenario={run.scenario}
                    >
                      <td className={t.td}>
                        <Flex direction="column" minW="0">
                          <Span fontWeight="500">{f.title}</Span>
                          <Span className={t.muted} fontFamily="mono">
                            {run.scenario}
                          </Span>
                        </Flex>
                      </td>
                      <td className={t.td}>
                        <Result run={run} />
                      </td>
                      <td className={t.td}>{f.assertions ? `${f.assertions.passed} / ${f.assertions.total}` : '—'}</td>
                      <td className={t.tdNumber}>{f.costUsd !== null ? formatCost(f.costUsd) : '—'}</td>
                      <td className={t.tdNumber}>{f.tokens !== null ? formatTokens(f.tokens) : '—'}</td>
                      <td className={t.td}>
                        <Span className={t.muted}>{f.model ?? '—'}</Span>
                      </td>
                      <td className={t.td}>
                        <styled.code fontFamily="mono" fontSize="1" color="text.muted">
                          {sha(f.gitSha)}
                        </styled.code>
                      </td>
                      <td className={t.td}>
                        <Span className={t.muted}>{formatAge(run.createdAt, now)}</Span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Box>
        </Flex>
      )}
      <HistoryDrawer scenario={open} onClose={() => setOpen(null)} />
    </Page>
  );
};
