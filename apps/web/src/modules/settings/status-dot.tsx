// Copied from carbonme modules/integrations/status-dot.tsx.
import { styled } from '@ops/ui/jsx';

const TONE_COLORS = {
  green: 'palette.green.9',
  amber: 'palette.amber.9',
  grey: 'brand.panel.20',
} as const;

/** A small status light beside a name: green connected or live, amber needs attention, grey off. */
export const StatusDot = ({ tone }: { tone: keyof typeof TONE_COLORS }) => (
  <styled.span
    aria-hidden
    display="inline-block"
    flexShrink="0"
    w="1.5"
    h="1.5"
    rounded="full"
    bg={TONE_COLORS[tone]}
  />
);
