// Rows adapted from carbonme modules/chats/chat-sidebar-list.tsx (ChatRow: a Link with a leading mark and a truncated
// title, the open one highlighted) with the status dot of carbonme's ChatRowIcon, as a section of the main sidebar.
import { Link } from '@tanstack/react-router';
import { css } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';

import type { RunSummary } from '../../api/generated/opsAgentAPI.schemas';
import { SidebarSection, sidebarMoreClass } from '../layout/components/sidebar-section';
import { runStatusDot } from './run-badges';
import { useRunLabel, useRuns } from './runs-api';

/** Recent runs listed in the sidebar. */
export const RUNS_SHOWN = 5;

const RunRow = ({ run, label, active }: { run: RunSummary; label: string; active: boolean }) => {
  const dot = runStatusDot(run.status);
  return (
    <Link
      to="/runs/$runId"
      params={{ runId: run.runId }}
      title={`${label} · ${dot.label}`}
      aria-current={active ? 'page' : undefined}
      data-sidebar-run={run.runId}
      className={css({
        display: 'flex',
        alignItems: 'center',
        gap: '2',
        h: '8',
        px: '2',
        rounded: 'md',
        _hover: { bg: 'brand.panel.6' },
        _focusVisible: { outline: '2px solid', outlineColor: 'border.focused', outlineOffset: '-2px' },
        '&[aria-current=page]': { bg: 'brand.panel.10' },
      })}
    >
      <styled.span display="grid" placeItems="center" w="3.5" flexShrink="0">
        <styled.span
          aria-label={dot.label}
          w="2"
          h="2"
          rounded="full"
          className={dot.className}
          data-run-status={run.status}
        />
      </styled.span>
      <styled.span fontSize="1" flex="1" minW="0" truncate fontWeight={active ? '500' : '400'}>
        {label}
      </styled.span>
    </Link>
  );
};

/** The sidebar's Runs: the latest restock and vendor-reply runs with their status, and a link to all of them. */
export const RunsSidebarSection = ({ pathname }: { pathname: string }) => {
  const runs = useRuns();
  const labelOf = useRunLabel();
  const items = (runs.data ?? []).slice(0, RUNS_SHOWN);
  return (
    <SidebarSection id="runs" label="Runs">
      {items.map((run) => (
        <RunRow key={run.runId} run={run} label={labelOf(run)} active={pathname === `/runs/${run.runId}`} />
      ))}
      {runs.isSuccess && !items.length && (
        <styled.p px="2" py="1.5" fontSize="1" color="text.muted">
          No runs yet.
        </styled.p>
      )}
      <Link to="/runs" className={sidebarMoreClass} data-sidebar-runs-all="">
        View all
      </Link>
    </SidebarSection>
  );
};
