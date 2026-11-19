import { styled } from '@ops/ui/jsx';

/** The app mark: a rounded tile with a check, drawn in the current text colour so it follows the theme. */
export const BrandMark = ({ size = '1rem' }: { size?: string }) => (
  <styled.svg
    aria-hidden="true"
    flexShrink="0"
    viewBox="0 0 24 24"
    fill="none"
    style={{ height: size, width: size }}
  >
    <rect x="2" y="2" width="20" height="20" rx="6" fill="currentColor" opacity="0.12" />
    <path d="M7 12.5l3.2 3.2L17 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </styled.svg>
);
