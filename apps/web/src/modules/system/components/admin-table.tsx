// Adapted from carbonme apps/admin/src/ui/table.tsx (rows on a grey panel, white cells, no borders).
import { css } from '@ops/ui/css';

/** "Oct 12": the admin's short date. */
const date = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** Rows on a grey panel, white cells, no borders, as in the mockup. */
export const tableStyles = {
  panel: css({
    bg: 'brand.panel.3',
    borderRadius: 'xl',
    overflowX: 'auto',
    p: '1.5',
  }),
  table: css({
    borderCollapse: 'separate',
    borderSpacing: '0 4px',
    fontSize: '2',
    minW: '48rem',
    w: 'full',
  }),
  th: css({
    color: 'text.muted',
    fontSize: '1',
    fontWeight: 'normal',
    px: '3',
    py: '1.5',
    textAlign: 'left',
  }),
  thNumber: css({
    color: 'text.muted',
    fontSize: '1',
    fontWeight: 'normal',
    px: '3',
    py: '1.5',
    textAlign: 'right',
  }),
  row: css({
    bg: 'background.app',
    '& > td:first-child': { borderLeftRadius: 'lg' },
    '& > td:last-child': { borderRightRadius: 'lg' },
  }),
  td: css({ px: '3', py: '2.5', verticalAlign: 'middle' }),
  /** Cells of rows that grow when opened keep to the top line. */
  tdTop: css({ px: '3', py: '2.5', verticalAlign: 'top' }),
  tdNumber: css({
    fontVariantNumeric: 'tabular-nums',
    px: '3',
    py: '2.5',
    textAlign: 'right',
  }),
  muted: css({ color: 'text.muted', fontSize: '1' }),
  empty: css({
    color: 'text.muted',
    fontSize: '2',
    p: '6',
    textAlign: 'center',
  }),
};

/** The dashboard's list table: a white canvas with a header row and hairline separators, no grey panel (carbonme
 * workspace-home ChatList rows and the settings Users table). */
export const lineTableStyles = {
  panel: css({ overflowX: 'auto' }),
  table: css({ borderCollapse: 'collapse', fontSize: '1.5', minW: '52rem', w: 'full' }),
  th: css({
    borderBottomWidth: '1px',
    borderColor: 'border.subtle',
    color: 'text.muted',
    fontSize: '1',
    fontWeight: 'normal',
    px: '3',
    py: '2',
    textAlign: 'left',
  }),
  thNumber: css({
    borderBottomWidth: '1px',
    borderColor: 'border.subtle',
    color: 'text.muted',
    fontSize: '1',
    fontWeight: 'normal',
    px: '3',
    py: '2',
    textAlign: 'right',
  }),
  row: css({
    borderBottomWidth: '1px',
    borderColor: 'border.subtle',
    transition: 'background 0.12s',
    _hover: { bg: 'background.muted' },
  }),
  td: css({ px: '3', py: '3', verticalAlign: 'middle' }),
  tdNumber: css({ fontVariantNumeric: 'tabular-nums', px: '3', py: '3', textAlign: 'right' }),
  muted: css({ color: 'text.muted', fontSize: '1' }),
  empty: css({ color: 'text.muted', fontSize: '2', p: '6', textAlign: 'center' }),
};

/** A row's date with its time underneath, as the logs show when something happened. */
export const WhenCell = ({ at }: { at: string }) => (
  <td className={tableStyles.tdTop}>
    {date(at)}
    <div className={tableStyles.muted}>
      {new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
    </div>
  </td>
);
