// Adapted from carbonme modules/chats/constants.ts + types.ts (answer-table tones), with restock statuses added.
export type AnswerStatusTone = 'bad' | 'warn' | 'good';

/** Answer-table cell text, lowercased, that shows as a status pill; any other text stays plain. */
export const ANSWER_STATUS_TONES: ReadonlyMap<string, AnswerStatusTone> =
  new Map([
    ['not met', 'bad'],
    ['missing', 'bad'],
    ['fail', 'bad'],
    ['failed', 'bad'],
    ['non-compliant', 'bad'],
    ['noncompliant', 'bad'],
    ['no', 'bad'],
    ['ok', 'good'],
    ['found', 'good'],
    ['blocked', 'bad'],
    ['late', 'bad'],
    ['order now', 'bad'],
    ['reorder now', 'bad'],
    ['order soon', 'warn'],
    ['watch', 'warn'],
    ['needs approval', 'warn'],
    ['partial', 'warn'],
    ['partially met', 'warn'],
    ['query', 'warn'],
    ['review', 'warn'],
    ['needs review', 'warn'],
    ['pending', 'warn'],
    ['unclear', 'warn'],
    ['met', 'good'],
    ['pass', 'good'],
    ['passed', 'good'],
    ['compliant', 'good'],
    ['yes', 'good'],
  ]);

/** Footnote marks and closing punctuation after a status ("Met*", "Partial."), ignored when matching its tone. */
export const ANSWER_STATUS_TRAILING_MARKS = /[\s*†‡.!]+$/u;

/** A reference such as M-07, REQ12 or #4: shown muted and monospaced when it leads a table row. */
export const ANSWER_TABLE_IDENTIFIER =
  /^(?:[A-Z]{1,5}[-_.]?\d[\w.-]{0,10}|#\d+)$/;

