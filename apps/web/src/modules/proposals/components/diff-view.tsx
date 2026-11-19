import { css } from '@ops/ui/css';
import { Box, Flex, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import type {
  FieldChange,
  FieldChangeKind,
} from '../../../api/generated/opsAgentAPI.schemas';
import {
  fieldOf,
  formatMoney,
  formatPath,
  formatScalar,
  isMoneyField,
  isQuantityField,
} from '../proposal-values';

/**
 * Colours per change kind, from the Radix scales so light and dark both hold contrast: step 3
 * tints the well, step 11 is the text, step 9 the rail. Literal css() calls so Panda extracts them.
 */
const KIND_STYLES: Record<
  FieldChangeKind,
  { label: string; rail: string; well: string; text: string; icon: keyof typeof Icons }
> = {
  added: {
    label: 'Added',
    rail: css({ bg: 'palette.green.9' }),
    well: css({ bg: 'palette.green.3', color: 'palette.green.11' }),
    text: css({ color: 'palette.green.11' }),
    icon: 'add',
  },
  removed: {
    label: 'Removed',
    rail: css({ bg: 'palette.red.9' }),
    well: css({ bg: 'palette.red.3', color: 'palette.red.11' }),
    text: css({ color: 'palette.red.11' }),
    icon: 'minus',
  },
  changed: {
    label: 'Changed',
    rail: css({ bg: 'palette.amber.9' }),
    well: css({ bg: { base: 'palette.orange.3', _dark: 'palette.amber.3' }, color: 'palette.amber.11' }),
    text: css({ color: 'palette.amber.11' }),
    icon: 'edit',
  },
};

const mutedText = css({ color: 'text.muted' });

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isRowList = (value: unknown): value is Row[] =>
  Array.isArray(value) && value.length > 0 && value.every(isRow);

/** Column order for line tables: identity first, then what is ordered, then money. */
const COLUMN_RANK = ['id', 'product_id', 'location_id', 'quantity', 'price', 'unit_price'];

const columnsOf = (rows: readonly Row[]) => {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const rank = (key: string) => {
    const index = COLUMN_RANK.indexOf(key);
    return index === -1 ? COLUMN_RANK.length : index;
  };
  return keys.sort((a, b) => rank(a) - rank(b));
};

const lineTotal = (row: Row) => {
  const quantity = row.quantity ?? row.qty;
  const price = row.price ?? row.unit_price;
  return typeof quantity === 'number' && typeof price === 'number'
    ? quantity * price
    : null;
};

const numericAlign = (key: string) =>
  isMoneyField(key) || isQuantityField(key) ? 'right' : 'left';

/** Arrays of records (Distru order lines) as a small table, with a line total when it can be computed. */
const LineTable = ({ rows, className }: { rows: Row[]; className: string }) => {
  const columns = columnsOf(rows);
  const totals = rows.map(lineTotal);
  const showTotal = totals.every((total) => total !== null);
  return (
    <Box overflowX="auto" maxW="full">
      <styled.table
        fontSize="1"
        borderCollapse="collapse"
        fontVariantNumeric="tabular-nums"
        className={className}
        css={{
          '& th': {
            fontWeight: '500',
            opacity: 0.75,
            textAlign: 'left',
            px: '2',
            py: '1',
            whiteSpace: 'nowrap',
          },
          '& td': { px: '2', py: '1', whiteSpace: 'nowrap' },
          '& tbody tr': { borderTopWidth: '1px', borderColor: 'border.subtle' },
        }}
      >
        <thead>
          <tr>
            {columns.map((key) => (
              <th key={key} style={{ textAlign: numericAlign(key) }}>
                {key}
              </th>
            ))}
            {showTotal && <th style={{ textAlign: 'right' }}>line total</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={typeof row.id === 'string' ? row.id : index}>
              {columns.map((key) => (
                <td key={key} style={{ textAlign: numericAlign(key) }}>
                  {formatScalar(key, row[key])}
                </td>
              ))}
              {showTotal && (
                <td style={{ textAlign: 'right', fontWeight: 500 }}>
                  {formatMoney(totals[index])}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </styled.table>
    </Box>
  );
};

/** One side of a change: a scalar inline, a record as key/value pairs, a list of records as a table. */
const Value = ({
  field,
  value,
  kind,
  side,
}: {
  field: string;
  value: unknown;
  kind: FieldChangeKind;
  side: 'before' | 'after';
}) => {
  const style = KIND_STYLES[kind];
  const old = side === 'before';
  const color = old && kind === 'changed' ? mutedText : style.text;

  if (isRowList(value)) return <LineTable rows={value} className={color} />;

  if (isRow(value)) {
    const entries = Object.entries(value);
    const total = lineTotal(value);
    return (
      <styled.dl
        display="grid"
        gridTemplateColumns="auto 1fr"
        columnGap="3"
        rowGap="0.5"
        fontSize="1"
        className={color}
        fontVariantNumeric="tabular-nums"
        textDecoration={old && kind === 'removed' ? 'line-through' : undefined}
      >
        {entries.map(([key, item]) => (
          <Box key={key} display="contents">
            <styled.dt opacity={0.75}>{key}</styled.dt>
            <styled.dd>{formatScalar(key, item)}</styled.dd>
          </Box>
        ))}
        {total !== null && (
          <Box display="contents">
            <styled.dt opacity={0.75}>line total</styled.dt>
            <styled.dd fontWeight="500">{formatMoney(total)}</styled.dd>
          </Box>
        )}
      </styled.dl>
    );
  }

  return (
    <styled.span
      fontFamily={typeof value === 'string' ? undefined : 'mono'}
      fontSize="1.5"
      fontVariantNumeric="tabular-nums"
      className={color}
      fontWeight={old ? '400' : '500'}
      textDecoration={old ? 'line-through' : undefined}
            overflowWrap="anywhere"
    >
      {formatScalar(field, value)}
    </styled.span>
  );
};

/** "+24 (+60%)" next to a changed number, so the size of a change reads without arithmetic. */
const Delta = ({ field, before, after }: { field: string; before: unknown; after: unknown }) => {
  if (typeof before !== 'number' || typeof after !== 'number' || before === after)
    return null;
  const delta = after - before;
  const pct = before === 0 ? null : Math.round((delta / Math.abs(before)) * 100);
  const sign = delta > 0 ? '+' : '−';
  const amount = isMoneyField(field)
    ? formatMoney(Math.abs(delta))
    : Math.abs(delta).toLocaleString();
  return (
    <styled.span
      fontSize="1"
      color="text.muted"
      fontVariantNumeric="tabular-nums"
      whiteSpace="nowrap"
    >
      {sign}
      {amount}
      {pct !== null ? ` (${sign}${Math.abs(pct)}%)` : ''}
    </styled.span>
  );
};

const ChangeRow = ({ change }: { change: FieldChange }) => {
  const style = KIND_STYLES[change.kind];
  const Icon = Icons[style.icon];
  const field = fieldOf(change.path);
  const block = isRow(change.before) || isRow(change.after) || isRowList(change.after) || isRowList(change.before);
  return (
    <styled.li
      display="grid"
      gridTemplateColumns={{ base: '1fr', md: 'minmax(9rem, 15rem) minmax(0, 1fr)' }}
      gap={{ base: '1.5', md: '4' }}
      alignItems="start"
      pl="3"
      pr="3"
      py="2.5"
      position="relative"
      borderTopWidth="1px"
      borderColor="border.subtle"
      _first={{ borderTopWidth: '0' }}
      data-diff-kind={change.kind}
      data-diff-path={formatPath(change.path)}
    >
      <Box position="absolute" left="0" top="2" bottom="2" w="2px" rounded="full" className={style.rail} />
      <HStack gap="2" minW="0" alignItems="center" pt="0.5">
        <Flex
          align="center"
          justify="center"
          flexShrink="0"
          w="5"
          h="5"
          rounded="md"
          className={style.well}
          title={style.label}
          aria-label={style.label}
        >
          <Icon size={11} />
        </Flex>
        <styled.code
          fontFamily="mono"
          fontSize="1"
          color="text.app"
          overflowWrap="anywhere"
          title={formatPath(change.path)}
        >
          {formatPath(change.path)}
        </styled.code>
      </HStack>
      <Flex
        direction={block ? 'column' : 'row'}
        align={block ? 'stretch' : 'center'}
        gap={block ? '2' : '2.5'}
        flexWrap="wrap"
        minW="0"
      >
        {change.kind !== 'added' && (
          <Box
            px={block ? '2.5' : '0'}
            py={block ? '2' : '0'}
            rounded="lg"
            className={block ? (change.kind === 'removed' ? style.well : css({ bg: 'brand.panel.3' })) : undefined}
            minW="0"
          >
            <Value field={field} value={change.before} kind={change.kind} side="before" />
          </Box>
        )}
        {change.kind === 'changed' && (
          <styled.span color="text.muted" display="flex" aria-label="becomes">
            <Icons.arrowRight size={12} />
          </styled.span>
        )}
        {change.kind !== 'removed' && (
          <Box
            px={block ? '2.5' : '2'}
            py={block ? '2' : '0.5'}
            rounded={block ? 'lg' : 'md'}
            className={style.well}
            minW="0"
          >
            <Value field={field} value={change.after} kind={change.kind} side="after" />
          </Box>
        )}
        {change.kind === 'changed' && (
          <Delta field={field} before={change.before} after={change.after} />
        )}
      </Flex>
    </styled.li>
  );
};

/** Counts per kind for the op header: "+5 ~2 −1". */
export const DiffCounts = ({ diff }: { diff: readonly FieldChange[] }) => {
  const counts = { added: 0, changed: 0, removed: 0 };
  for (const change of diff) counts[change.kind] += 1;
  return (
    <HStack gap="2" fontSize="1" fontWeight="500" fontVariantNumeric="tabular-nums">
      {counts.added > 0 && <styled.span color="palette.green.11">+{counts.added}</styled.span>}
      {counts.changed > 0 && <styled.span color="palette.amber.11">~{counts.changed}</styled.span>}
      {counts.removed > 0 && <styled.span color="palette.red.11">−{counts.removed}</styled.span>}
    </HStack>
  );
};

/**
 * The field-level diff of one op: every field the write will add, change or remove, with its path
 * (`items[id=li-1].quantity`), the value before and after, and money and quantities formatted.
 */
export const DiffView = ({ diff }: { diff: readonly FieldChange[] }) => {
  if (diff.length === 0)
    return (
      <Box px="3" py="3" fontSize="1.5" color="text.muted" data-diff-empty="">
        No field changes: the record already matches.
      </Box>
    );
  return (
    <styled.ul listStyle="none" m="0" p="0" data-testid="diff-view">
      {diff.map((change) => (
        <ChangeRow key={`${change.kind}:${formatPath(change.path)}`} change={change} />
      ))}
    </styled.ul>
  );
};
