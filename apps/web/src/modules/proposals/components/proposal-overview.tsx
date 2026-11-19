// The Overview tab of the proposal record page: the agent's rationale (carbonme MarkdownDocument with the Copilot's
// answer tables), the ops grouped by system as carbonme apps/admin/src/ui/stat-card.tsx cards, flagged items as
// carbonme ToolApprovalCard's amber write warning, and a one-line policy chip linking to the Policy checks tab.
import { Box, Flex, Grid, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { MarkdownDocument } from '@ops/ui/primitives/markdown';
import { Span } from '@ops/ui/primitives/text';
import type { ProposalDetail } from '../../../api/generated/opsAgentAPI.schemas';
import { ANSWER_COMPONENTS } from '../../copilot/answer-components';
import { formatMoney } from '../proposal-values';
import { flagsOf, groupsOf, titleParts, type Flag } from '../proposal-record';
import { AMBER_TINT } from './badges';
import { PolicyBadge } from './badges';

const SectionTitle = ({ children, count }: { children: React.ReactNode; count?: number }) => (
  <HStack gap="2">
    <styled.h3 fontSize="1.5" fontWeight="600">
      {children}
    </styled.h3>
    {count !== undefined ? (
      <Span color="text.muted" fontSize="1.5">
        {count}
      </Span>
    ) : null}
  </HStack>
);

const FLAG_ICONS: Record<Flag['kind'], keyof typeof Icons> = {
  veto: 'ban',
  suspicious: 'shieldCheck',
  guard: 'gauge',
  critique: 'messageSquare',
};

const FlagRow = ({ flag }: { flag: Flag }) => {
  const Icon = Icons[FLAG_ICONS[flag.kind]];
  const warn = flag.kind === 'veto' || flag.kind === 'suspicious';
  return (
    <HStack
      gap="2.5"
      alignItems="flex-start"
      px="3"
      py="2.5"
      rounded="lg"
      bg={warn ? AMBER_TINT : 'brand.panel.2'}
      color={warn ? 'palette.amber.11' : 'text.app'}
      fontSize="1.5"
      data-flag={flag.kind}
    >
      <Icon size={14} flexShrink="0" mt="0.5" />
      <Flex direction="column" gap="1" minW="0">
        <Span fontWeight="500">{flag.title}</Span>
        {flag.detail ? <Span color={warn ? 'palette.amber.11' : 'text.muted'}>{flag.detail}</Span> : null}
        {flag.excerpt ? (
          <styled.blockquote
            fontSize="1"
            fontFamily="mono"
            color="text.muted"
            bg="background.app"
            rounded="md"
            px="2.5"
            py="1.5"
            overflowWrap="anywhere"
            title="Untrusted text from the ERP, shown as data. The agents did not follow it."
          >
            {flag.excerpt}
          </styled.blockquote>
        ) : null}
      </Flex>
    </HStack>
  );
};

/** Overview: why, what it touches (grouped by system, each opens Changes filtered), what was flagged, policy. */
export const ProposalOverview = ({
  proposal,
  openSystem,
  openPolicy,
}: {
  proposal: ProposalDetail;
  openSystem: (system: string) => void;
  openPolicy: () => void;
}) => {
  const groups = groupsOf(proposal);
  const flags = flagsOf(proposal);
  const written = proposal.ops.filter((op) => op.status === 'executed').length;
  const failed = proposal.ops.filter((op) => op.status === 'failed').length;
  const { summary } = titleParts(proposal);

  return (
    <Flex direction="column" gap="7" px="5" py="5" data-testid="proposal-overview">
      {summary ? (
        <Span fontSize="2" color="text.label" data-overview-summary="">
          {summary}
        </Span>
      ) : null}
      <styled.button type="button" onClick={openPolicy} alignSelf="flex-start" display="flex" alignItems="center" gap="2" cursor="pointer" fontSize="1" color="text.muted" _hover={{ color: 'text.app' }} data-overview-policy="">
        <PolicyBadge outcome={proposal.policy.outcome} />
        {proposal.policy.reasons.filter((reason) => reason.outcome !== 'pass').length} of {proposal.policy.reasons.length} rules flagged · see Policy checks
        <Icons.caretRight size={10} />
      </styled.button>
      <Flex direction="column" gap="3">
        <SectionTitle count={proposal.opCount}>What it changes</SectionTitle>
        <Grid gridTemplateColumns="repeat(auto-fill, minmax(12rem, 1fr))" gap="2">
          {groups.map((group) => {
            const Icon = Icons[group.icon];
            return (
              <styled.button
                key={group.key}
                type="button"
                onClick={() => openSystem(group.key)}
                display="grid"
                gap="1"
                p="3.5"
                rounded="xl"
                bg="brand.panel.3"
                textAlign="left"
                cursor="pointer"
                _hover={{ bg: 'brand.panel.4' }}
                data-system-group={group.key}
              >
                <HStack gap="1.5" color="text.muted" fontSize="1">
                  <Icon size={13} />
                  {group.label}
                </HStack>
                <Span fontSize="3" fontWeight="600" fontVariantNumeric="tabular-nums">
                  {group.ops.length} op{group.ops.length === 1 ? '' : 's'}
                </Span>
                <Span color="text.muted" fontSize="1" fontVariantNumeric="tabular-nums">
                  {group.value > 0 ? formatMoney(group.value) : 'No value'} ·{' '}
                  {group.ops.filter((op) => op.status === 'executed').length} written
                </Span>
              </styled.button>
            );
          })}
        </Grid>
        <Span color="text.muted" fontSize="1">
          Total {formatMoney(proposal.totalValue)} across {proposal.opCount} op{proposal.opCount === 1 ? '' : 's'}
          {written ? ` · ${written} written` : ''}
          {failed ? ` · ${failed} failed` : ''}
        </Span>
      </Flex>

      {flags.length > 0 ? (
        <Flex direction="column" gap="3" data-testid="proposal-flags">
          <SectionTitle count={flags.length}>Flagged</SectionTitle>
          <Flex direction="column" gap="1.5">
            {flags.map((flag, index) => (
              <FlagRow key={`${flag.kind}:${index}`} flag={flag} />
            ))}
          </Flex>
        </Flex>
      ) : null}

      {proposal.rationale ? (
        <Flex direction="column" gap="3">
          <SectionTitle>
            <HStack gap="1.5" as="span">
              <Icons.sparkle size={13} />
              Why the agent proposed this
            </HStack>
          </SectionTitle>
          <Box fontSize="1.5" css={{ '& table': { fontSize: '1' } }}>
            <MarkdownDocument text={proposal.rationale} variant="answer" components={ANSWER_COMPONENTS} />
          </Box>
        </Flex>
      ) : null}

    </Flex>
  );
};
