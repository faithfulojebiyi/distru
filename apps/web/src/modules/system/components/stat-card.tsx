// Copied from carbonme apps/admin/src/ui/stat-card.tsx (Ops Agent: optional `hint` tooltip for what the note leaves out).
import { css } from '@ops/ui/css';
import type { ReactNode } from 'react';

/** One number on a grey card: a label, the value large, and a muted line under it. */
export const StatCard = ({
  label,
  value,
  note,
  tone,
  hint,
}: {
  label: string;
  value: ReactNode;
  /** One short line (it never wraps); put anything longer in `hint`. */
  note?: ReactNode;
  tone?: 'bad';
  /** Tooltip for the whole card (details that do not fit the note). */
  hint?: string;
}) => (
  <div
    title={hint}
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
        title={!hint && typeof note === 'string' ? note : undefined}
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
