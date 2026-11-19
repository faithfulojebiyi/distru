// The right pane of the proposal record page (Attio-style record sidebar): collapsible sections of label–value rows
// adapted from carbonme apps/admin/src/modules/customers/panel.tsx (Panel + Facts), the Decision section is carbonme
// ToolApprovalCard (decision-panel.tsx), and "Show all values" follows carbonme
// modules/integrations/mcp-connector-page.tsx's FIRST_TOOLS "Show N more" toggle.
import { Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { Box, Flex, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { Span } from '@ops/ui/primitives/text';
import type { ProposalDetail } from '../../../api/generated/opsAgentAPI.schemas';
import { usePolicyRules } from '../../settings/settings-api';
import { formatDateTime, formatMoney } from '../proposal-values';
import { groupsOf } from '../proposal-record';
import { PolicyBadge, RiskBadge, StatusBadge } from './badges';
import { DecisionPanel, type Decision } from './decision-panel';
import { CreatedBy } from './proposal-inbox';
import { ResumePanel } from './undo-panel';

/** A titled block that folds away, as Attio's "Record Details". */
export const SideSection = ({
  title,
  action,
  children,
  defaultOpen = true,
  ...data
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
} & Record<`data-${string}`, string>) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Flex as="section" direction="column" gap="2" py="3" borderBottomWidth="1px" borderColor="border.subtle" {...data}>
      <HStack gap="1.5" justify="space-between">
        <styled.button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          display="flex"
          alignItems="center"
          gap="1.5"
          fontSize="1.5"
          fontWeight="600"
          cursor="pointer"
        >
          <styled.span color="text.muted" display="flex" transform={open ? 'rotate(90deg)' : undefined} transition="transform 0.15s">
            <Icons.caretRight size={11} />
          </styled.span>
          {title}
        </styled.button>
        {action}
      </HStack>
      {open ? children : null}
    </Flex>
  );
};

/** One label–value row with a small leading icon (carbonme Facts, Attio's record rows). */
const Row = ({ icon, label, children }: { icon: keyof typeof Icons; label: string; children: ReactNode }) => {
  const Icon = Icons[icon];
  return (
    <Box display="grid" gridTemplateColumns="8.5rem minmax(0, 1fr)" alignItems="center" gap="3" minH="8" fontSize="1.5" data-detail={label}>
      <HStack gap="2" color="text.muted" minW="0">
        <Icon size={13} flexShrink="0" />
        <Span truncate>{label}</Span>
      </HStack>
      <Box minW="0">{children}</Box>
    </Box>
  );
};

const Chip = ({ children }: { children: ReactNode }) => (
  <styled.span display="inline-flex" alignItems="center" gap="1" h="6" px="2" rounded="md" bg="brand.panel.4" fontSize="1" whiteSpace="nowrap">
    {children}
  </styled.span>
);

const ShowAll = ({ open, toggle, more }: { open: boolean; toggle: () => void; more: number }) =>
  more > 0 ? (
    <styled.button type="button" onClick={toggle} alignSelf="flex-start" display="flex" alignItems="center" gap="1" fontSize="1" color="text.muted" cursor="pointer" _hover={{ color: 'text.app' }}>
      {open ? 'Show fewer values' : 'Show all values'}
      <Icons.caretRight size={10} />
    </styled.button>
  ) : null;

const RecordDetails = ({ proposal }: { proposal: ProposalDetail }) => {
  const [all, setAll] = useState(false);
  const systems = groupsOf(proposal);
  const keys = proposal.ops.filter((op) => op.idempotencyKey).length;
  return (
    <SideSection title="Record details" data-side-section="details">
      <Flex direction="column">
        <Row icon="checkCircle" label="Status">
          <StatusBadge status={proposal.status} />
        </Row>
        <Row icon="dollar" label="Total">
          <Span fontWeight="500" fontVariantNumeric="tabular-nums">
            {formatMoney(proposal.totalValue)}
          </Span>
        </Row>
        <Row icon="shieldCheck" label="Policy outcome">
          <PolicyBadge outcome={proposal.policyOutcome} />
        </Row>
        <Row icon="warn" label="Highest risk">
          {proposal.maxRisk ? <RiskBadge risk={proposal.maxRisk} /> : <Span color="text.muted">None</Span>}
        </Row>
        <Row icon="integrations" label="Systems">
          <HStack gap="1" flexWrap="wrap">
            {systems.map((system) => (
              <Chip key={system.key}>
                {system.label}
                <Span color="text.muted">{system.ops.length}</Span>
              </Chip>
            ))}
          </HStack>
        </Row>
        <Row icon="aiUser" label="Proposed by">
          <Box color="text.app">
            <CreatedBy principal={proposal.createdBy} />
          </Box>
        </Row>
        <Row icon="calendar" label="Created">
          {formatDateTime(proposal.createdAt)}
        </Row>
        {all ? (
          <>
            <Row icon="hash" label="Version">
              v{proposal.version}
            </Row>
            <Row icon="workflow" label="Run">
              {proposal.workflowRunId ? (
                <Link to="/runs/$runId" params={{ runId: proposal.workflowRunId }}>
                  <styled.code fontFamily="mono" fontSize="1" textDecoration="underline" textUnderlineOffset="2px">
                    {proposal.workflowRunId.slice(0, 8)}
                  </styled.code>
                </Link>
              ) : (
                <Span color="text.muted">None</Span>
              )}
            </Row>
            <Row icon="key" label="Idempotency keys">
              {keys} of {proposal.opCount}
            </Row>
            <Row icon="clock" label="Updated">
              {formatDateTime(proposal.updatedAt)}
            </Row>
            {proposal.execution?.finishedAt ? (
              <Row icon="checkCheck" label="Finished">
                {formatDateTime(proposal.execution.finishedAt)}
              </Row>
            ) : null}
            <Row icon="document" label="Proposal id">
              <styled.code fontFamily="mono" fontSize="1" color="text.muted" truncate display="block" title={proposal.id}>
                {proposal.id}
              </styled.code>
            </Row>
          </>
        ) : null}
      </Flex>
      <ShowAll open={all} toggle={() => setAll(!all)} more={5} />
    </SideSection>
  );
};

const num = (value: unknown) => (typeof value === 'number' ? value : null);
const text = (value: unknown) => (typeof value === 'string' ? value : null);

/** The policy limits this proposal was judged against: auto-approve threshold and the total cap first. */
const Limits = () => {
  const rules = usePolicyRules();
  const [all, setAll] = useState(false);
  const items = (rules.data?.items ?? []).filter((rule) => rule.enabled);
  const auto = items.find((rule) => rule.key === 'auto_approve_below');
  const cap = items.find((rule) => rule.key === 'max_total_value');
  const others = items.filter((rule) => rule !== auto && rule !== cap);
  return (
    <SideSection
      title="Limits"
      data-side-section="limits"
      action={
        <Link to="/settings/policy">
          <Span fontSize="1" color="text.muted" _hover={{ color: 'text.app' }}>
            Policy rules
          </Span>
        </Link>
      }
    >
      {rules.isError ? (
        <Span color="text.muted" fontSize="1.5">
          Could not load the policy rules.
        </Span>
      ) : (
        <Flex direction="column">
          <Row icon="lightning" label="Auto-approve">
            {auto ? (
              <span>
                Below {formatMoney(num(auto.params.amount))}
                {text(auto.params.max_risk) ? <Span color="text.muted">, up to {text(auto.params.max_risk)} risk</Span> : null}
              </span>
            ) : (
              <Span color="text.muted">Off</Span>
            )}
          </Row>
          <Row icon="gauge" label="Total cap">
            {cap ? formatMoney(num(cap.params.max)) : <Span color="text.muted">None</Span>}
          </Row>
          {all
            ? others.map((rule) => (
                <Row key={rule.key} icon="shieldCheck" label={rule.key.replace(/_/g, ' ')}>
                  <Span color="text.muted" fontSize="1" lineClamp="2" title={rule.description ?? undefined}>
                    {rule.description ?? 'On'}
                  </Span>
                </Row>
              ))
            : null}
        </Flex>
      )}
      <ShowAll open={all} toggle={() => setAll(!all)} more={others.length} />
    </SideSection>
  );
};

/** Details: record details, the decision (form while pending, the record after), resume, and the limits. */
export const ProposalDetails = ({ proposal, decision }: { proposal: ProposalDetail; decision: Decision }) => (
  <Flex direction="column" px="4" data-testid="proposal-details">
    <RecordDetails proposal={proposal} />
    <SideSection title="Decision" data-side-section="decision">
      <DecisionPanel proposal={proposal} decision={decision} />
    </SideSection>
    {proposal.resumable || proposal.status === 'failed' ? (
      <SideSection title="Resume" data-side-section="resume">
        <ResumePanel proposal={proposal} />
      </SideSection>
    ) : null}
    <Limits />
  </Flex>
);
