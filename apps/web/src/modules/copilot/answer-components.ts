// Adapted from carbonme modules/chats/chat-answer-components.ts.
import type { MarkdownComponents } from '@ops/ui/primitives/markdown';

import { AnswerCell, AnswerHeader, AnswerTable } from './answer-table';

/** How a Chat answer draws its tables, for the answer's Markdown document; one object, so the renderer keeps it. */
export const ANSWER_COMPONENTS: MarkdownComponents = {
  table: AnswerTable,
  th: AnswerHeader,
  td: AnswerCell,
};
