// Copied from carbonme apps/admin/src/ui/stat-card.tsx.
import { css } from '@ops/ui/css';
import type { ReactNode } from 'react';

/** One number on a grey card: a label, the value large, and a muted line under it. */
export const StatCard = ({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: 'bad';
}) => (
  <div
    className={css({
      bg: 'brand.panel.3',
      borderRadius: 'xl',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'flex-start',
      gap: '1',
      h: 'full',
      minW: '0',
      p: '4',
    })}
  >
    <span className={css({ color: 'text.muted', fontSize: '1' })}>{label}</span>
    <strong
      className={css({
        color: tone === 'bad' ? 'palette.red.11' : 'text.app',
        fontSize: '4',
        fontVariantNumeric: 'tabular-nums',
        fontWeight: 'semibold',
      })}
    >
      {value}
    </strong>
    {note ? (
      <span
        title={typeof note === 'string' ? note : undefined}
        className={css({
          color: 'text.muted',
          fontSize: '1',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        })}
      >
        {note}
      </span>
    ) : null}
  </div>
);
