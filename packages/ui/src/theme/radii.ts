import { defineTokens } from '@pandacss/dev';

export const radii = defineTokens.radii({
  '2xl': {
    value: '1rem',
  },
  '3xl': {
    value: '1.5rem',
  },
  '4xl': {
    value: '2rem',
  },
  /** Chat cards: connector requests and approvals. */
  chatCard: {
    value: '0.875rem',
  },
  /** A white well or notice inside a Chat card. */
  chatWell: {
    value: '0.625rem',
  },
  /** An app mark's tile in a Chat card, small and large. */
  chatTile: {
    value: '0.5625rem',
  },
  chatTileLg: {
    value: '0.6875rem',
  },
  full: {
    value: '9999px',
  },
  lg: {
    value: '0.5rem',
  },
  md: {
    value: '0.375rem',
  },
  none: {
    value: '0',
  },
  sm: {
    value: '0.25rem',
  },
  xl: {
    value: '0.75rem',
  },
  xs: {
    value: '0.125rem',
  },
});
