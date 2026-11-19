// Adapted from carbonme apps/admin/src/ui/pager.tsx (First page and Next under a paged table).
import { css } from '@ops/ui/css';
import { Button } from '@ops/ui/primitives/button';

/** First page and Next under a cursor-paged table. */
export const Pager = ({
  cursor,
  nextCursor,
  onPage,
}: {
  cursor: string | undefined;
  nextCursor: string | null | undefined;
  onPage: (cursor: string | undefined) => void;
}) => (
  <footer
    className={css({
      display: 'flex',
      gap: '2',
      justifyContent: 'flex-end',
      mt: '3',
    })}
  >
    <Button
      variant="soft"
      disabled={!cursor}
      onClick={() => onPage(undefined)}
      size="xs"
    >
      First page
    </Button>
    <Button
      variant="soft"
      disabled={!nextCursor}
      onClick={() => onPage(nextCursor ?? undefined)}
      size="xs"
    >
      Next
    </Button>
  </footer>
);
