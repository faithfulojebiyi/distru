// The proposal record page, laid out as an Attio record page (full-height split view): a record header with actions
// and a meta chip row, then a left pane with underline tabs (Overview · Changes · Audit trail) and a ~400px right pane
// (Details · Undo), each scrolling on its own. The header and its actions follow carbonme
// apps/admin/src/modules/customers/customer-layout.tsx (title + status + action buttons, a muted meta line); the tab
// strips are @ops/ui Tabs' "underline" variant (carbonme's record-page tab strip); chips are carbonme
// modules/audit MetaChip; panes reuse carbonme ToolApprovalCard (decision), SideDrawer (audit) and admin Panel/Facts.
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Box, Flex, Grid, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { Button } from '@ops/ui/primitives/button';
import { Skeleton } from '@ops/ui/primitives/skeleton';
import { Tabs } from '@ops/ui/primitives/tabs';
import { Span } from '@ops/ui/primitives/text';
import { isNotFoundError } from '../../../api/errors';
import type { ProposalDetail } from '../../../api/generated/opsAgentAPI.schemas';
import { resolveOpRef } from '../../audit/audit-refs';
import { AuditTimeline, AuditTimelineSkeleton } from '../../audit/components/audit-timeline';
import { AuditDrawer } from '../../audit/components/audit-drawer';
import { RecordIcon, RecordTab, RecordTabBar } from '../../system/components/record-tabs';
import { EmptyState, ErrorState } from '../../system/components/states';
import { useNow } from '../../system/use-now';
import { LIVE_STATUSES, formatAge, formatMoney } from '../proposal-values';
import { groupsOf, namesOf, proposalIcon, titleParts } from '../proposal-record';
import { useAuditEvents, useLocationNames, useProposal } from '../proposals-api';
import { StatusBadge } from './badges';
import { DecisionButtons, useDecision } from './decision-panel';
import { DiffContextProvider } from './diff-view';
import { ProposalChanges } from './proposal-changes';
import { CreatedBy } from './proposal-inbox';
import { ProposalOverview } from './proposal-overview';
import { ProposalPolicy, policyTone } from './proposal-policy';
import { ProposalDetails } from './proposal-side';
import { UndoOfBanner, UndoPanel } from './undo-panel';

export const PROPOSAL_TABS = ['overview', 'changes', 'policy', 'audit', 'details', 'undo'] as const;
export type ProposalTab = (typeof PROPOSAL_TABS)[number];
export const SIDE_TABS = ['details', 'undo'] as const;
export type SideTab = (typeof SIDE_TABS)[number];

export type ProposalSearch = { event?: string; tab?: ProposalTab; side?: SideTab };

/** While the executor works: a live strip that updates as the poll brings news. */
const ExecutionBanner = ({ proposal }: { proposal: ProposalDetail }) => {
  if (!LIVE_STATUSES.includes(proposal.status) || proposal.status === 'auto_approved') return null;
  const written = proposal.ops.filter((op) => op.status === 'executed').length;
  return (
    <HStack gap="2.5" px="4" py="2" rounded="lg" bg="palette.blue.3" color="palette.blue.11" fontSize="1.5" role="status" data-execution-banner="">
      <Icons.loading size={14} />
      <span>
        {proposal.status === 'approved'
          ? 'Approved. Waiting for the executor to pick it up…'
          : `Writing: ${written} of ${proposal.ops.length} op${proposal.ops.length === 1 ? '' : 's'} done`}
      </span>
    </HStack>
  );
};

const ExecutionError = ({ proposal }: { proposal: ProposalDetail }) => {
  const error = proposal.execution?.error;
  if (!error) return null;
  return (
    <HStack gap="2.5" alignItems="flex-start" px="4" py="2" rounded="lg" bg="brand.error.3" color="text.error" fontSize="1.5" role="alert">
      <Icons.alertCircle size={14} flexShrink="0" mt="0.5" />
      <span>Execution failed: {error.message}</span>
    </HStack>
  );
};

/** A small rounded chip in the meta row (carbonme audit MetaChip; Attio's "Alex Smith – about 3 hours ago"). */
const MetaChip = ({ icon, children, ...data }: { icon?: keyof typeof Icons; children: ReactNode } & Record<`data-${string}`, string>) => {
  const Icon = icon ? Icons[icon] : null;
  return (
    <HStack gap="1.5" h="6" px="2" rounded="md" borderWidth="1px" borderColor="border.subtle" fontSize="1" color="text.label" whiteSpace="nowrap" {...data}>
      {Icon ? <Icon size={12} flexShrink="0" /> : null}
      {children}
    </HStack>
  );
};

/** The proposal's audit trail; an event opens the same drawer as the audit log (?event=<id>, ↑/↓ steps). */
const ProposalTrail = ({ proposal, openEventId }: { proposal: ProposalDetail; openEventId: string | null }) => {
  const live = LIVE_STATUSES.includes(proposal.status);
  const navigate = useNavigate();
  const events = useAuditEvents({ proposalId: proposal.id, order: 'asc', limit: 500 }, { live });
  const list = events.data ?? [];
  const openIndex = openEventId ? list.findIndex((event) => event.id === openEventId) : -1;
  const open = (id: string | undefined, replace = false) =>
    void navigate({
      to: '/approvals/$proposalId',
      params: { proposalId: proposal.id },
      search: (prev: ProposalSearch) => ({ ...prev, event: id }),
      replace,
      resetScroll: false,
    });
  return (
    <Flex direction="column" gap="3" px="5" py="5" data-testid="proposal-trail">
      <HStack justify="space-between">
        <Span fontWeight="600" fontSize="1.5">
          Audit trail
        </Span>
        <Link to="/audit" search={{ proposalId: proposal.id }}>
          <Span color="text.muted" fontSize="1" _hover={{ color: 'text.app' }}>
            Open in audit log
          </Span>
        </Link>
      </HStack>
      {events.isPending ? (
        <AuditTimelineSkeleton />
      ) : events.isError ? (
        <Span color="text.muted" fontSize="1.5">
          Could not load the audit trail.
        </Span>
      ) : list.length === 0 ? (
        <Span color="text.muted" fontSize="1.5">
          No events recorded yet.
        </Span>
      ) : (
        <AuditTimeline events={list} selected={openEventId} onOpen={(event) => open(event.id)} />
      )}
      <AuditDrawer
        event={openIndex >= 0 ? (list[openIndex] ?? null) : null}
        title={proposal.title}
        onClose={() => open(undefined, true)}
        onStep={(direction) => {
          const next = list[openIndex + direction];
          if (next) open(next.id, true);
        }}
        position={openIndex >= 0 ? { index: openIndex, total: list.length } : null}
      />
    </Flex>
  );
};

const DetailSkeleton = () => (
  <Flex direction="column" gap="4" p="6" aria-busy="true">
    <Skeleton h="8" w="50%" rounded="md" />
    <Skeleton h="6" w="70%" rounded="md" />
    <Grid gridTemplateColumns={{ base: '1fr', lg: 'minmax(0, 1fr) 25rem' }} gap="5">
      <Skeleton h="80" rounded="xl" />
      <Skeleton h="80" rounded="xl" />
    </Grid>
  </Flex>
);

/** Who decided / what can be done now, as header buttons (duplicated in the Details pane's Decision section). */
const HeaderActions = ({
  proposal,
  decision,
  openUndo,
}: {
  proposal: ProposalDetail;
  decision: ReturnType<typeof useDecision>;
  openUndo: () => void;
}) => {
  const undoProposal = proposal.undo.undoProposalId;
  return (
    <HStack gap="2" flexWrap="wrap" justify="flex-end" flexShrink="0">
      {proposal.workflowRunId ? (
        <Button asChild size="sm" variant="outline">
          <Link to="/runs/$runId" params={{ runId: proposal.workflowRunId }} data-run-link="">
            <Icons.workflow size={13} />
            Open run
          </Link>
        </Button>
      ) : null}
      {undoProposal ? (
        <Button asChild size="sm" variant="outline">
          <Link to="/approvals/$proposalId" params={{ proposalId: undoProposal }} data-header-undo-link="">
            <Icons.undo size={13} />
            Open undo proposal
          </Link>
        </Button>
      ) : proposal.undo.available ? (
        <Button size="sm" variant="outline" onClick={openUndo} data-header-undo="">
          <Icons.undo size={13} />
          Propose undo
        </Button>
      ) : null}
      {proposal.status === 'pending_approval' ? <DecisionButtons proposal={proposal} decision={decision} size="sm" /> : null}
    </HStack>
  );
};

/** The record page: header + meta chips, then the left (tabs) and right (Details · Undo) panes. */
export const ProposalDetailView = ({
  proposalId,
  search,
}: {
  proposalId: string;
  search: ProposalSearch;
}) => {
  const proposal = useProposal(proposalId);
  const now = useNow(60_000);
  const { hash } = useLocation();
  const navigate = useNavigate();
  const loaded = proposal.data !== undefined;
  const [openOps, setOpenOps] = useState<ReadonlySet<number>>(new Set());
  const [system, setSystem] = useState<string | null>(null);
  const events = useAuditEvents(
    { proposalId, order: 'asc', limit: 500 },
    { live: proposal.data ? LIVE_STATUSES.includes(proposal.data.status) : false },
  );
  const locations = useLocationNames();

  const setSearch = (patch: Partial<ProposalSearch>, keepHash = false) =>
    void navigate({
      to: '/approvals/$proposalId',
      params: { proposalId },
      search: (prev: ProposalSearch) => ({ ...prev, ...patch }),
      hash: keepHash ? hash : undefined,
      replace: true,
      resetScroll: false,
    });

  // Op anchors (#op-N, from the audit drawer): switch to Changes, open that op, then scroll it into view.
  useEffect(() => {
    if (!loaded || !hash.startsWith('op-')) return;
    const index = Number(hash.slice(3));
    if (!Number.isInteger(index)) return;
    setOpenOps((prev) => new Set([...prev, index]));
    setSystem(null);
    if (search.tab !== 'changes') setSearch({ tab: 'changes' }, true);
    const timer = setTimeout(() => document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, hash]);

  const diffContext = useMemo(
    () =>
      proposal.data
        ? {
            names: namesOf(proposal.data, locations.data ?? []),
            resolveRef: (ref: Parameters<typeof resolveOpRef>[0]) => resolveOpRef(ref, proposal.data?.ops ?? []),
          }
        : null,
    [proposal.data, locations.data],
  );

  const decisionSource = proposal.data;
  if (proposal.isPending) return <DetailSkeleton />;
  if (proposal.isError || !decisionSource || !diffContext)
    return isNotFoundError(proposal.error) ? (
      <Box p="6">
        <EmptyState
          illustration="search"
          title="Proposal not found"
          hint="It may have been removed, or the link is wrong."
          action={
            <Link to="/approvals" search={{ status: 'pending' }}>
              <Span fontSize="1.5" fontWeight="500">
                Back to approvals
              </Span>
            </Link>
          }
        />
      </Box>
    ) : (
      <Box p="6">
        <ErrorState title="Could not load this proposal" error={proposal.error} retry={() => void proposal.refetch()} />
      </Box>
    );

  return (
    <RecordPage
      proposal={decisionSource}
      search={search}
      setSearch={setSearch}
      openOp={(index) =>
        void navigate({
          to: '/approvals/$proposalId',
          params: { proposalId },
          search: (prev: ProposalSearch): ProposalSearch => ({ ...prev, tab: 'changes' }),
          hash: `op-${index}`,
          replace: true,
          resetScroll: false,
        })
      }
      now={now}
      openOps={openOps}
      setOpenOps={setOpenOps}
      system={system}
      setSystem={setSystem}
      eventCount={events.data?.length}
      diffContext={diffContext}
    />
  );
};

const RecordPage = ({
  proposal,
  search,
  setSearch,
  openOp,
  now,
  openOps,
  setOpenOps,
  system,
  setSystem,
  eventCount,
  diffContext,
}: {
  proposal: ProposalDetail;
  search: ProposalSearch;
  setSearch: (patch: Partial<ProposalSearch>) => void;
  openOp: (index: number) => void;
  now: number;
  openOps: ReadonlySet<number>;
  setOpenOps: (open: ReadonlySet<number>) => void;
  system: string | null;
  setSystem: (system: string | null) => void;
  eventCount: number | undefined;
  diffContext: NonNullable<Parameters<typeof DiffContextProvider>[0]['value']>;
}) => {
  const decision = useDecision(proposal);
  const undoOf = proposal.undoOf ?? proposal.undo.undoOf;
  const hasUndo = proposal.ops.some((op) => op.status === 'executed') && proposal.undo.ops.length > 0;
  const tab: ProposalTab = search.tab ?? 'overview';
  const side: SideTab = search.side === 'undo' && hasUndo ? 'undo' : 'details';
  const systems = groupsOf(proposal);
  const { title, summary } = titleParts(proposal);
  const undoCount = proposal.undo.ops.filter((op) => op.canUndo && !op.undoProposalId).length;

  const openUndo = () => setSearch({ side: 'undo', ...(tab === 'details' ? { tab: 'undo' } : {}) });

  // Every panel stays mounted and is only hidden, so switching tabs never remounts (no height jump, scroll kept).
  const leftPanels: { key: ProposalTab; body: ReactNode; narrowOnly?: boolean }[] = [
    {
      key: 'overview',
      body: (
        <ProposalOverview
          proposal={proposal}
          openPolicy={() => setSearch({ tab: 'policy' })}
          openSystem={(key) => {
            setSystem(key);
            setSearch({ tab: 'changes' });
          }}
        />
      ),
    },
    {
      key: 'changes',
      body: <ProposalChanges proposal={proposal} open={openOps} setOpen={setOpenOps} system={system} setSystem={setSystem} />,
    },
    { key: 'policy', body: <ProposalPolicy proposal={proposal} openOp={openOp} /> },
    { key: 'audit', body: <ProposalTrail proposal={proposal} openEventId={search.event ?? null} /> },
  ];
  const details = <ProposalDetails proposal={proposal} decision={decision} />;
  const undo = (
    <Box px="4" py="4">
      <UndoPanel proposal={proposal} />
    </Box>
  );
  // On wide screens Details / Undo live in the right pane, so those left tabs fall back to Overview.
  const leftShown = tab;

  return (
    <DiffContextProvider value={diffContext}>
      <Flex direction="column" h="full" minH="0" data-testid="proposal-detail" data-proposal-id={proposal.id}>
        {/* Record header: icon tile + short title (summary under it), actions on the right. Full-bleed bottom border. */}
        <Flex
          align={{ base: 'flex-start', md: 'center' }}
          direction={{ base: 'column', md: 'row' }}
          justify="space-between"
          gap="3"
          px={{ base: '4', md: '6' }}
          py="3"
          flexShrink="0"
          borderBottomWidth="1px"
          borderColor="border.subtle"
          data-record-header=""
        >
          <HStack gap="3" minW="0" flex="1" alignItems="center" w={{ base: 'full', md: 'auto' }}>
            <RecordIcon icon={proposalIcon(proposal)} />
            <Flex direction="column" gap="0.5" minW="0" flex="1">
              <styled.h2 fontSize="3" fontWeight="600" letterSpacing="-0.01em" lineHeight="2rem" truncate title={proposal.title ?? undefined} data-proposal-title="">
                {title}
              </styled.h2>
              {summary ? (
                <Span color="text.muted" fontSize="1.5" lineClamp="2" title={summary} data-proposal-summary="">
                  {summary}
                </Span>
              ) : null}
            </Flex>
          </HStack>
          <HeaderActions proposal={proposal} decision={decision} openUndo={openUndo} />
        </Flex>

        {/* Meta chip row, full-bleed bottom border. */}
        <Flex direction="column" gap="2" px={{ base: '4', md: '6' }} py="2.5" flexShrink="0" bg="brand.panel.1" borderBottomWidth="1px" borderColor="border.subtle">
          <HStack gap="1.5" flexWrap="wrap">
            <MetaChip data-meta="proposed-by">
              <CreatedBy principal={proposal.createdBy} />
            </MetaChip>
            <MetaChip icon="clock" data-meta="created">
              {formatAge(proposal.createdAt, now)}
            </MetaChip>
            <StatusBadge status={proposal.status} />
            <MetaChip icon="dollar" data-meta="total">
              <Span fontWeight="600" color="text.app" fontVariantNumeric="tabular-nums" data-proposal-total="">
                {formatMoney(proposal.totalValue)}
              </Span>
            </MetaChip>
            <MetaChip icon="integrations" data-meta="systems">
              {systems.length} system{systems.length === 1 ? '' : 's'} · {proposal.opCount} op{proposal.opCount === 1 ? '' : 's'}
            </MetaChip>
            {proposal.workflowRunId ? (
              <Link to="/runs/$runId" params={{ runId: proposal.workflowRunId }}>
                <MetaChip icon="workflow" data-meta="run">
                  Run <styled.code fontFamily="mono">{proposal.workflowRunId.slice(0, 8)}</styled.code>
                </MetaChip>
              </Link>
            ) : null}
          </HStack>
          {undoOf ? <UndoOfBanner originalId={undoOf} /> : null}
          <ExecutionBanner proposal={proposal} />
          <ExecutionError proposal={proposal} />
        </Flex>

        {/* Split view: the left pane flexes, the right pane is a fixed 400px; each scrolls on its own. */}
        <Flex flex="1" minH="0" minW="0">
          <Tabs
            value={tab}
            onValueChange={(value) => setSearch({ tab: value as ProposalTab, event: undefined })}
            display="flex"
            flexDirection="column"
            flex="1"
            minH="0"
            minW="0"
          >
            <RecordTabBar label="Proposal">
              <RecordTab value="overview" icon="activity" label="Overview" data-proposal-tab="overview" />
              <RecordTab value="changes" icon="editSquare" label="Changes" count={proposal.opCount} data-proposal-tab="changes" />
              <RecordTab value="policy" icon="shieldCheck" label="Policy checks" count={proposal.policy.reasons.length} tone={policyTone(proposal)} data-proposal-tab="policy" />
              <RecordTab value="audit" icon="checklist" label="Audit trail" count={eventCount ?? null} data-proposal-tab="audit" />
              <RecordTab value="details" icon="infoSquare" label="Details" hideFrom="xl" data-proposal-tab="details" />
              {hasUndo ? <RecordTab value="undo" icon="undo" label="Undo" count={undoCount} hideFrom="xl" data-proposal-tab="undo" /> : null}
            </RecordTabBar>
            <Box position="relative" flex="1" minH="0" data-left-pane="">
              {leftPanels.map((panel) => {
                const active = leftShown === panel.key || ((leftShown === 'details' || leftShown === 'undo') && panel.key === 'overview');
                return (
                  <Box
                    key={panel.key}
                    position="absolute"
                    inset="0"
                    overflowY={panel.key === 'changes' ? 'hidden' : 'auto'}
                    style={{ scrollbarGutter: 'stable', display: active ? undefined : 'none' }}
                    hideBelow={panel.key === 'overview' && (leftShown === 'details' || leftShown === 'undo') ? 'xl' : undefined}
                    data-left-panel={panel.key}
                  >
                    {panel.body}
                  </Box>
                );
              })}
              <Box
                position="absolute"
                inset="0"
                overflowY="auto"
                hideFrom="xl"
                style={{ scrollbarGutter: 'stable', display: leftShown === 'details' || leftShown === 'undo' ? undefined : 'none' }}
              >
                {leftShown === 'undo' && hasUndo ? undo : details}
              </Box>
            </Box>
          </Tabs>

          <Tabs
            value={side}
            onValueChange={(value) => setSearch({ side: value as SideTab })}
            hideBelow="xl"
            display="flex"
            flexDirection="column"
            minH="0"
            flexShrink="0"
            borderLeftWidth="1px"
            borderColor="border.subtle"
            style={{ width: RIGHT_PANE_WIDTH, minWidth: RIGHT_PANE_WIDTH, maxWidth: RIGHT_PANE_WIDTH }}
            data-right-pane=""
          >
            <RecordTabBar label="Record">
              <RecordTab value="details" icon="infoSquare" label="Details" data-side-tab="details" />
              {hasUndo ? <RecordTab value="undo" icon="undo" label="Undo" count={undoCount} data-side-tab="undo" /> : null}
            </RecordTabBar>
            <Box position="relative" flex="1" minH="0">
              <Box position="absolute" inset="0" overflowY="auto" style={{ scrollbarGutter: 'stable', display: side === 'details' ? undefined : 'none' }} data-side-panel="details">
                {details}
              </Box>
              {hasUndo ? (
                <Box position="absolute" inset="0" overflowY="auto" style={{ scrollbarGutter: 'stable', display: side === 'undo' ? undefined : 'none' }} data-side-panel="undo">
                  {undo}
                </Box>
              ) : null}
            </Box>
          </Tabs>
        </Flex>
      </Flex>
    </DiffContextProvider>
  );
};

/** Literal so it is never content-sized (Attio's record sidebar). */
const RIGHT_PANE_WIDTH = 400;

