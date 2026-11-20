// Search box adapted from carbonme modules/integrations/integrations-page.tsx (IntegrationsCatalogue: the
// searchNormal icon inside the Input, the muted "No … match" status line, Skeleton rows while loading); badges are
// this app's Pill tones (proposals/components/badges.tsx).
import { useEffect, useState } from 'react';
import { Box, Flex, HStack, styled } from '@ops/ui/jsx';
import { Icons } from '@ops/ui/icons/base';
import { Input } from '@ops/ui/primitives/input';
import { Skeleton } from '@ops/ui/primitives/skeleton';

import type { RecallPassage } from '../../api/generated/opsAgentAPI.schemas';
import { Pill, TONES } from '../proposals/components/badges';
import { useRecallSearch } from './recall-api';

const SOURCE_LABELS: Record<RecallPassage['source'], string> = { email: 'Email', vendor_reply: 'Vendor reply', po_note: 'PO note' };

const useDebounced = (value: string, ms = 300) => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
};

/** One recalled passage: subject, vendor, date, source and an excerpt; flagged when it looks like an injection. */
const PassageRow = ({ passage }: { passage: RecallPassage }) => (
  <styled.li py="3" borderBottomWidth="1px" borderColor="border.subtle" _last={{ borderBottomWidth: 0 }} listStyle="none">
    <HStack gap="2" flexWrap="wrap">
      <styled.span fontWeight="600" fontSize="2">
        {passage.subject?.untrusted_text ?? '(no subject)'}
      </styled.span>
      <Pill tone={TONES.muted} label={SOURCE_LABELS[passage.source]} />
      {passage.suspicious && <Pill tone={TONES.bad} label="Suspicious text" data-recall-suspicious="true" />}
    </HStack>
    <styled.p color="text.muted" fontSize="1.5" mt="0.5">
      {[passage.vendor?.name, passage.date.slice(0, 10), ...passage.po_numbers].filter(Boolean).join(' · ')}
    </styled.p>
    {passage.text && (
      <styled.p fontSize="1.5" mt="1.5" lineClamp="3" whiteSpace="pre-line">
        {passage.text.untrusted_text}
      </styled.p>
    )}
  </styled.li>
);

/**
 * "Search history": semantic search over the purchasing mailbox and PO notes, shown on the Copilot's
 * empty state. Results are quoted external text (never rendered as markdown or links).
 */
export const RecallSearch = () => {
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const query = useRecallSearch(q);
  const term = q.trim();
  return (
    <Box w="full" maxW="40rem" mx="auto" mt="8" data-testid="recall-search">
      <styled.p fontWeight="600" fontSize="2" mb="2">
        Search history
      </styled.p>
      <Box pos="relative">
        <styled.span pos="absolute" left="2.5" top="50%" transform="translateY(-50%)" color="text.muted" display="flex" pointerEvents="none">
          <Icons.searchNormal size={14} />
        </styled.span>
        <Input aria-label="Search vendor emails and PO notes" placeholder="Search vendor emails and PO notes" value={search} onChange={(event) => setSearch(event.target.value)} pl="8" />
      </Box>
      {term.length >= 2 &&
        (query.isPending ? (
          <Flex direction="column" gap="2" mt="3" aria-hidden>
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} h="12" rounded="lg" />
            ))}
          </Flex>
        ) : query.isError ? (
          <styled.p color="text.muted" fontSize="1.5" mt="3" role="status">
            Search history is unavailable right now.
          </styled.p>
        ) : query.data.passages.length === 0 ? (
          <styled.p color="text.muted" fontSize="1.5" mt="3" role="status">
            Nothing in the history matches “{term}”.
          </styled.p>
        ) : (
          <styled.ul mt="2" aria-label="History results">
            {query.data.passages.map((passage) => (
              <PassageRow key={passage.ref} passage={passage} />
            ))}
          </styled.ul>
        ))}
    </Box>
  );
};
