import { css } from '@ops/ui/css';
import { styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import type {
  PolicyOutcome,
  ProposalStatus,
  Risk,
} from '../../../api/generated/opsAgentAPI.schemas';
import { POLICY_LABELS, STATUS_LABELS } from '../proposal-values';

/** The warm tint for waiting and for changes; the light amber scale is too yellow (carbonme). */
export const AMBER_TINT = {
  base: 'palette.orange.3',
  _dark: 'palette.amber.3',
} as const;

/**
 * A tone is a tinted fill + text colour and a dot colour. Built with literal css() calls so Panda
 * extracts every class statically (values read out of a lookup table at runtime are not).
 */
export type Tone = { className: string; dot: string; spin?: boolean };

export const TONES = {
  waiting: {
    className: css({ bg: { base: 'palette.orange.3', _dark: 'palette.amber.3' }, color: 'palette.amber.11' }),
    dot: css({ bg: 'palette.amber.9' }),
  },
  running: {
    className: css({ bg: 'brand.panel.5', color: 'text.label' }),
    dot: css({ bg: 'brand.panel.20' }),
    spin: true,
  },
  good: {
    className: css({ bg: 'palette.green.3', color: 'palette.green.11' }),
    dot: css({ bg: 'palette.green.9' }),
  },
  info: {
    className: css({ bg: 'palette.blue.3', color: 'palette.blue.11' }),
    dot: css({ bg: 'palette.blue.9' }),
  },
  bad: {
    className: css({ bg: 'brand.error.3', color: 'text.error' }),
    dot: css({ bg: 'brand.error.9' }),
  },
  muted: {
    className: css({ bg: 'brand.panel.5', color: 'text.muted' }),
    dot: css({ bg: 'brand.panel.20' }),
  },
} satisfies Record<string, Tone>;

const STATUS_TONES: Record<ProposalStatus, Tone> = {
  draft: TONES.muted,
  pending_approval: TONES.waiting,
  auto_approved: TONES.info,
  approved: TONES.running,
  executing: TONES.running,
  executed: TONES.good,
  rejected: TONES.muted,
  denied: TONES.bad,
  failed: TONES.bad,
};

const POLICY_TONES: Record<PolicyOutcome, Tone> = {
  allow: TONES.good,
  needs_approval: TONES.waiting,
  deny: TONES.bad,
};

const RISK_TONES: Record<NonNullable<Risk>, Tone> = {
  low: TONES.muted,
  medium: TONES.waiting,
  high: TONES.bad,
};

/** A status as a tinted pill with a dot, never an outline (carbonme's ToolRunBadge). */
export const Pill = ({
  tone,
  label,
  ...rest
}: {
  tone: Tone;
  label: string;
} & Record<`data-${string}`, string>) => (
  <styled.span
    display="inline-flex"
    alignItems="center"
    gap="1.5"
    flexShrink="0"
    h="20px"
    px="2"
    rounded="full"
    fontSize="1"
    fontWeight="500"
    whiteSpace="nowrap"
    className={tone.className}
    {...rest}
  >
    {tone.spin ? (
      <Icons.loading size={10} />
    ) : (
      <styled.span aria-hidden w="1.5" h="1.5" rounded="full" className={tone.dot} />
    )}
    {label}
  </styled.span>
);

export const StatusBadge = ({ status }: { status: ProposalStatus }) => (
  <Pill
    tone={STATUS_TONES[status]}
    label={STATUS_LABELS[status]}
    data-proposal-status={status}
  />
);

export const PolicyBadge = ({ outcome }: { outcome: PolicyOutcome }) => (
  <Pill
    tone={POLICY_TONES[outcome]}
    label={POLICY_LABELS[outcome]}
    data-policy-outcome={outcome}
  />
);

export const RiskBadge = ({ risk }: { risk: NonNullable<Risk> }) => (
  <Pill
    tone={RISK_TONES[risk]}
    label={`${risk[0]?.toUpperCase()}${risk.slice(1)} risk`}
    data-risk={risk}
  />
);
