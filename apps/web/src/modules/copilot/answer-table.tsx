// Adapted from carbonme modules/chats/chat-answer-table.tsx (answer tables: borderless raised rows, status pills).
import { css, cva } from '@ops/ui/css';
import type { MarkdownComponents } from '@ops/ui/primitives/markdown';

import {
  ANSWER_STATUS_TONES,
  ANSWER_STATUS_TRAILING_MARKS,
  ANSWER_TABLE_IDENTIFIER,
} from './answer-table-constants';
import type { AnswerStatusTone } from './answer-table-constants';

/** The table's own box scrolls sideways on a narrow Chat, so the page never does. */
const scrollStyle = css({
  maxW: 'full',
  overflowX: 'auto',
  overscrollBehaviorX: 'contain',
  my: '3',
  p: '1',
  rounded: 'xl',
  bg: 'brand.panel.3',
  _focusVisible: {
    outline: '2px solid',
    outlineOffset: '2px',
    outlineColor: 'brand.info.9',
  },
});

/** Borderless rows as raised bands with rounded ends; child selectors outrank the document's own cell rules, and the
 * document's `& table` collapse rule outranks a class, so the band spacing is marked important. */
const tableStyle = css({
  w: 'full',
  minW: '30rem',
  borderCollapse: 'separate !important',
  borderSpacing: '0 2px !important',
  fontSize: '1.5',
  lineHeight: '1.5',
  '& > thead > tr > th': {
    border: 'none',
    bg: 'transparent',
    color: 'text.muted',
    fontSize: '1',
    fontWeight: '500',
    textAlign: 'left',
    px: '2.5',
    py: '1',
    whiteSpace: 'nowrap',
  },
  '& > tbody > tr > td': {
    border: 'none',
    bg: 'background.item',
    px: '2.5',
    py: '2',
    verticalAlign: 'top',
    whiteSpace: 'normal',
    overflowWrap: 'break-word',
  },
  '& > tbody > tr > td:first-child': { roundedLeft: 'lg' },
  '& > tbody > tr > td:last-child': { roundedRight: 'lg' },
  '& > tbody > tr > td[data-identifier]:first-child': {
    color: 'text.muted',
    fontFamily: 'mono',
    fontSize: '1',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
});

const pillStyle = cva({
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    h: '5',
    px: '2',
    rounded: 'full',
    fontSize: '1',
    fontWeight: '500',
    whiteSpace: 'nowrap',
  },
  variants: {
    tone: {
      bad: { bg: 'status.bad.bg', color: 'status.bad.fg' },
      warn: { bg: 'status.warn.bg', color: 'status.warn.fg' },
      good: { bg: 'status.good.bg', color: 'status.good.fg' },
    },
  },
});

/** The reading text of a hast node; chip markers carry none. */
const textOf = (node: unknown): string => {
  if (!node || typeof node !== 'object') return '';

  const value = Reflect.get(node, 'value');

  if (typeof value === 'string') return value;

  const children = Reflect.get(node, 'children');

  if (!Array.isArray(children)) return '';

  return children.map((child: unknown) => textOf(child)).join('');
};

const toneOf = (text: string): AnswerStatusTone | undefined =>
  ANSWER_STATUS_TONES.get(
    text.replace(ANSWER_STATUS_TRAILING_MARKS, '').trim().toLowerCase(),
  );

export const AnswerTable: MarkdownComponents['table'] = ({ children }) => (
  <div
    className={scrollStyle}
    data-markdown-table=""
    data-answer-table=""
    role="region"
    aria-label="Table"
    tabIndex={0}
  >
    <table className={tableStyle}>{children}</table>
  </div>
);

export const AnswerHeader: MarkdownComponents['th'] = ({
  node: _node,
  ...props
}) => <th scope="col" {...props} />;

/** A cell whose whole text is a known status shows it as a pill, the words still there; a reference stays muted. */
export const AnswerCell: MarkdownComponents['td'] = ({
  node,
  children,
  ...props
}) => {
  const text = textOf(node).trim();

  const tone = toneOf(text);

  return (
    <td
      {...props}
      data-identifier={ANSWER_TABLE_IDENTIFIER.test(text) ? '' : undefined}
      data-status={tone}
    >
      {tone ? (
        <span className={pillStyle({ tone })}>{children}</span>
      ) : (
        children
      )}
    </td>
  );
};
