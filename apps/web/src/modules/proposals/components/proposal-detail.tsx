import { Link } from '@tanstack/react-router';
import { Box, Flex, Grid, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { MarkdownDocument } from '@ops/ui/primitives/markdown';
import { Skeleton } from '@ops/ui/primitives/skeleton';
import { Heading, Span } from '@ops/ui/primitives/text';
import { isNotFoundError } from '../../../api/errors';
import type {
  ProposalDetail,
  ProposalOp,
} from '../../../api/generated/opsAgentAPI.schemas';
import {
  AuditTimeline,
  AuditTimelineSkeleton,
} from '../../audit/components/audit-timeline';
import { EmptyState, ErrorState } from '../../system/components/states';
import {
  LIVE_STATUSES,
  actionLabel,
  formatDateTime,
  formatMoney,
  formatPath,
  formatInline,
  fieldOf,
} from '../proposal-values';
import { useAuditEvents, useProposal } from '../proposals-api';
import { Pill, RiskBadge, StatusBadge, TONES } from './badges';
import { connectorTitle } from '../../settings/connectors-page';
import { SYSTEM_LABELS, useConnectors } from '../../settings/settings-api';
import { DecisionPanel } from './decision-panel';
import { DiffCounts, DiffView } from './diff-view';
import { CreatedBy } from './proposal-inbox';
import { PolicyPanel } from './policy-panel';

const OP_STATUS = {
  pending: { tone: TONES.muted, label: 'Not written' },
  executed: { tone: TONES.good, label: 'Written' },
  failed: { tone: TONES.bad, label: 'Failed' },
} as const;

const Fact = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <Flex direction="column" gap="0.5" minW="0">
    <Span fontSize="1" color="text.muted">
      {label}
    </Span>
    <Box fontSize="1.5" minW="0">
      {children}
    </Box>
  </Flex>
);

/** What the executor did with one op: the record it wrote, attempts, dedupe, verify mismatches, error. */
const OpResult = ({ op }: { op: ProposalOp }) => {
  const result = op.result;
  if (!result) return null;
  const failed = op.status === 'failed';
  return (
    <Flex
      direction="column"
      gap="2.5"
      px="3"
      py="2.5"
      borderTopWidth="1px"
      borderColor="border.subtle"
      bg={failed ? 'brand.error.2' : undefined}
      data-op-result={op.status}
    >
      <HStack gap="5" flexWrap="wrap" fontSize="1.5">
        <Fact label="Record">
          <styled.code fontFamily="mono" fontSize="1">
            {result.recordId ?? '—'}
          </styled.code>
        </Fact>
        <Fact label="Attempts">{result.attempts}</Fact>
        <Fact label="Duplicate">
          {result.deduplicated ? (
            <HStack gap="1" color="palette.blue.11">
              <Icons.copyCheck size={13} />
              Reused existing record
            </HStack>
          ) : (
            'No'
          )}
        </Fact>
        <Fact label="Finished">{formatDateTime(result.finishedAt)}</Fact>
      </HStack>
      {result.mismatches.length > 0 && (
        <Flex direction="column" gap="1">
          <Span fontSize="1" color="text.error" fontWeight="500">
            Read-after-write found {result.mismatches.length} mismatch
            {result.mismatches.length === 1 ? '' : 'es'}
          </Span>
          <styled.ul listStyle="none" m="0" p="0" display="flex" flexDirection="column" gap="1">
            {result.mismatches.map((mismatch, index) => (
              <styled.li
                key={`${formatPath(mismatch.path)}:${index}`}
                display="grid"
                gridTemplateColumns={{ base: '1fr', md: 'minmax(8rem, 14rem) 1fr 1fr' }}
                gap="2"
                fontSize="1"
                px="2.5"
                py="1.5"
                rounded="md"
                bg="background.app"
              >
                <styled.code fontFamily="mono">{formatPath(mismatch.path)}</styled.code>
                <Span color="text.muted" overflowWrap="anywhere">
                  expected {mismatch.expected === undefined ? '(nothing)' : formatInline(mismatch.expected, fieldOf(mismatch.path))}
                </Span>
                <Span color="text.muted" overflowWrap="anywhere">
                  got {mismatch.actual === undefined ? '(nothing)' : formatInline(mismatch.actual, fieldOf(mismatch.path))}
                </Span>
              </styled.li>
            ))}
          </styled.ul>
        </Flex>
      )}
      {result.error && (
        <HStack gap="2" alignItems="flex-start" fontSize="1.5" color="text.error" role="alert">
          <Icons.alertCircle size={14} flexShrink="0" mt="0.5" />
          <span>
            {result.error.message}
            {result.error.code ? (
              <Span color="text.muted" fontSize="1">
                {' '}
                ({result.error.code})
              </Span>
            ) : null}
          </span>
        </HStack>
      )}
    </Flex>
  );
};

/** One ERP write: what it is, its risk and value, and the field-level diff it will apply. */
/** The system an op writes to, from the connector whose catalogue lists its action (ERP, Email, …). */
const SystemBadge = ({ action }: { action: string }) => {
  const connectors = useConnectors();
  const connector = connectors.data?.find((item) =>
    item.tools.some((tool) => tool.kind === 'action' && tool.name === action),
  );
  if (!connector) return null;
  return (
    <Pill
      tone={TONES.info}
      label={`${SYSTEM_LABELS[connector.system] ?? connector.system} · ${connectorTitle(connector.id)}`}
      data-op-system={connector.system}
    />
  );
};

const OpCard = ({ op, total }: { op: ProposalOp; total: number }) => {
  const status = OP_STATUS[op.status];
  return (
    <Flex
      as="article"
      direction="column"
      rounded="xl"
      bg="brand.panel.2"
      overflow="hidden"
      data-op-index={op.index}
    >
      <Flex direction="column" gap="2" px="4" pt="3.5" pb="3">
        <HStack gap="2" justify="space-between" flexWrap="wrap">
          <HStack gap="2" minW="0">
            <Flex
              align="center"
              justify="center"
              w="6"
              h="6"
              rounded="lg"
              bg="background.app"
              color="text.muted"
              flexShrink="0"
            >
              <Icons.document size={13} />
            </Flex>
            <Span fontWeight="600" fontSize="1.5">
              {actionLabel(op.action)}
            </Span>
            {total > 1 && (
              <Span color="text.muted" fontSize="1">
                op {op.index + 1} of {total}
              </Span>
            )}
          </HStack>
          <HStack gap="2" flexWrap="wrap">
            <SystemBadge action={op.action} />
            <RiskBadge risk={op.risk} />
            <Pill tone={status.tone} label={status.label} data-op-status={op.status} />
          </HStack>
        </HStack>
        <HStack gap="3" justify="space-between" flexWrap="wrap">
          <Span fontSize="1.5">{op.summary ?? op.action}</Span>
          <HStack gap="3">
            <DiffCounts diff={op.diff} />
            <Span fontWeight="600" fontSize="1.5" fontVariantNumeric="tabular-nums">
              {formatMoney(op.value)}
            </Span>
          </HStack>
        </HStack>
        <Span color="text.muted" fontSize="1">
          <styled.code fontFamily="mono">{op.action}</styled.code> on {op.resource}
        </Span>
      </Flex>
      <Box mx="1.5" mb="1.5" rounded="lg" bg="background.app" overflow="hidden">
        <DiffView diff={op.diff} />
        <OpResult op={op} />
      </Box>
    </Flex>
  );
};

/** While the executor works: a live strip that updates as the poll brings news. */
const ExecutionBanner = ({ proposal }: { proposal: ProposalDetail }) => {
  if (!LIVE_STATUSES.includes(proposal.status) || proposal.status === 'auto_approved')
    return null;
  const written = proposal.ops.filter((op) => op.status === 'executed').length;
  return (
    <HStack
      gap="2.5"
      px="4"
      py="2.5"
      rounded="xl"
      bg="palette.blue.3"
      color="palette.blue.11"
      fontSize="1.5"
      role="status"
      data-execution-banner=""
    >
      <Icons.loading size={14} />
      <span>
        {proposal.status === 'approved'
          ? 'Approved. Waiting for the executor to pick it up…'
          : `Writing to Distru: ${written} of ${proposal.ops.length} op${proposal.ops.length === 1 ? '' : 's'} done`}
      </span>
    </HStack>
  );
};

const ExecutionError = ({ proposal }: { proposal: ProposalDetail }) => {
  const error = proposal.execution?.error;
  if (!error) return null;
  return (
    <HStack
      gap="2.5"
      alignItems="flex-start"
      px="4"
      py="3"
      rounded="xl"
      bg="brand.error.3"
      color="text.error"
      fontSize="1.5"
      role="alert"
    >
      <Icons.alertCircle size={14} flexShrink="0" mt="0.5" />
      <span>
        Execution failed: {error.message}
      </span>
    </HStack>
  );
};

const ProposalTrail = ({ proposal }: { proposal: ProposalDetail }) => {
  const live = LIVE_STATUSES.includes(proposal.status);
  const events = useAuditEvents(
    { proposalId: proposal.id, order: 'asc', limit: 500 },
    { live },
  );
  return (
    <Flex direction="column" gap="3" p="4" rounded="xl" bg="brand.panel.2" data-testid="proposal-trail">
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
      ) : events.data.length === 0 ? (
        <Span color="text.muted" fontSize="1.5">
          No events recorded yet.
        </Span>
      ) : (
        <AuditTimeline events={events.data} />
      )}
    </Flex>
  );
};

const Header = ({ proposal }: { proposal: ProposalDetail }) => (
  <Flex direction="column" gap="3">
    <Flex
      direction={{ base: 'column', md: 'row' }}
      justify="space-between"
      align={{ base: 'flex-start', md: 'flex-end' }}
      gap="3"
    >
      <Flex direction="column" gap="2" minW="0">
        <HStack gap="2">
          <StatusBadge status={proposal.status} />
        </HStack>
        <Heading as="h2" fontSize="4" fontWeight="600" letterSpacing="-0.01em" lineHeight="1.3">
          {proposal.title ?? 'Untitled proposal'}
        </Heading>
      </Flex>
      <Flex direction="column" align={{ base: 'flex-start', md: 'flex-end' }} gap="0.5" flexShrink="0">
        <Span fontSize="1" color="text.muted">
          Total value
        </Span>
        <Span
          fontSize="5"
          fontWeight="600"
          fontVariantNumeric="tabular-nums"
          letterSpacing="-0.02em"
          lineHeight="1.1"
          data-proposal-total=""
        >
          {formatMoney(proposal.totalValue)}
        </Span>
      </Flex>
    </Flex>
    <HStack gap="5" flexWrap="wrap" py="2.5" borderTopWidth="1px" borderBottomWidth="1px" borderColor="border.subtle">
      <Fact label="Proposed by">
        <Box color="text.app">
          <CreatedBy principal={proposal.createdBy} />
        </Box>
      </Fact>
      <Fact label="Created">{formatDateTime(proposal.createdAt)}</Fact>
      <Fact label="Ops">{proposal.opCount}</Fact>
      <Fact label="Version">
        <styled.span fontVariantNumeric="tabular-nums">v{proposal.version}</styled.span>
      </Fact>
      {proposal.workflowRunId ? (
        <Fact label="Run">
          <Link to="/runs/$runId" params={{ runId: proposal.workflowRunId }} data-run-link="">
            <styled.code fontFamily="mono" fontSize="1" textDecoration="underline" textUnderlineOffset="2px">
              {proposal.workflowRunId.slice(0, 8)}
            </styled.code>
          </Link>
        </Fact>
      ) : null}
      {proposal.execution?.finishedAt ? (
        <Fact label="Finished">{formatDateTime(proposal.execution.finishedAt)}</Fact>
      ) : null}
    </HStack>
  </Flex>
);

const DetailSkeleton = () => (
  <Flex direction="column" gap="4" aria-busy="true">
    <Skeleton h="3" w="20" rounded="md" />
    <Skeleton h="7" w="60%" rounded="md" />
    <Skeleton h="10" w="full" rounded="lg" />
    <Grid gridTemplateColumns={{ base: '1fr', xl: 'minmax(0, 1fr) 22rem' }} gap="5">
      <Flex direction="column" gap="4">
        <Skeleton h="28" rounded="xl" />
        <Skeleton h="56" rounded="xl" />
      </Flex>
      <Flex direction="column" gap="4">
        <Skeleton h="36" rounded="xl" />
        <Skeleton h="48" rounded="xl" />
      </Flex>
    </Grid>
  </Flex>
);

/** The proposal page: header, the agent's reasoning, every op's diff, and on the side the decision, policy and trail. */
export const ProposalDetailView = ({ proposalId }: { proposalId: string }) => {
  const proposal = useProposal(proposalId);

  if (proposal.isPending) return <DetailSkeleton />;
  if (proposal.isError)
    return isNotFoundError(proposal.error) ? (
      <EmptyState
        illustration="search"
        title="Proposal not found"
        hint="It may have been removed, or the link is wrong."
        action={
          <Link to="/approvals" search={{ status: 'pending' }}>
            <Span fontSize="1.5" fontWeight="500">Back to approvals</Span>
          </Link>
        }
      />
    ) : (
      <ErrorState title="Could not load this proposal" retry={() => void proposal.refetch()} />
    );

  const data = proposal.data;
  return (
    <Flex direction="column" gap="5" w="full" data-testid="proposal-detail">
      <Header proposal={data} />
      <ExecutionBanner proposal={data} />
      <ExecutionError proposal={data} />
      <Grid gridTemplateColumns={{ base: '1fr', xl: 'minmax(0, 1fr) 23rem' }} gap="5" alignItems="start">
        <Flex direction="column" gap="4" minW="0">
          {data.rationale ? (
            <Flex direction="column" gap="2" p="4" rounded="xl" bg="brand.panel.2">
              <HStack gap="1.5" color="text.muted" fontSize="1">
                <Icons.sparkle size={12} />
                Why the agent proposed this
              </HStack>
              <Box fontSize="1.5" css={{ '& table': { fontSize: '1' } }}>
                <MarkdownDocument text={data.rationale} variant="answer" />
              </Box>
            </Flex>
          ) : null}
          <Flex direction="column" gap="3">
            {data.ops.map((op) => (
              <OpCard key={op.index} op={op} total={data.ops.length} />
            ))}
          </Flex>
        </Flex>
        <Flex direction="column" gap="4" minW="0" position={{ xl: 'sticky' }} top={{ xl: '0' }}>
          <DecisionPanel proposal={data} />
          <PolicyPanel policy={data.policy} />
          <ProposalTrail proposal={data} />
        </Flex>
      </Grid>
    </Flex>
  );
};
