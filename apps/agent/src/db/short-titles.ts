import { undoTitle } from '@ops/harness';
import { fitTitle, TITLE_TARGET_CHARS, vendorReplyTemplateTitle } from '../harness/titles';

/**
 * A short title for a proposal stored before titles were split into title + summary (the old long
 * title moves to `summary`). Pure; used by scripts/backfill-titles.ts.
 */
export function deriveShortTitle(title: string): string {
  if (title.length <= TITLE_TARGET_CHARS) return title;
  const undo = /^Undo: (.*)$/s.exec(title);
  if (undo) return undoTitle(deriveShortTitle(undo[1]!));
  const restock = /^Restock: (\d+) POs? \([^)]*\) for (.*?)(?: \+ .*)?$/s.exec(title);
  if (restock) {
    const vendors = restock[2]!.split(/, (?=[A-Z])/).filter(Boolean);
    return vendors.length === 1 ? fitTitle('Restock · ', vendors[0]!) : `Restock ${vendors.length} vendors`;
  }
  const reply = /^Vendor reply: .* on (PO-\d+) \((\w+)\)$/s.exec(title);
  if (reply) return vendorReplyTemplateTitle(reply[1]!, reply[2]!);
  return fitTitle('', title.replace(/\s+/g, ' '));
}
