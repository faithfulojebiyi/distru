// Dialog frame adapted from carbonme modules/workflows/components/execution-details.tsx (ExecutionHeader + body +
// footer); location rows from carbonme mcp-connector-page ToolRow.
import { useState } from 'react';
import { Box, Flex, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { Button } from '@ops/ui/primitives/button';
import { Checkbox } from '@ops/ui/primitives/checkbox/checkbox';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '@ops/ui/primitives/dialog';
import { Skeleton } from '@ops/ui/primitives/skeleton';
import { apiErrorMessage } from '../../api/errors';
import { useRunLocations, useStartRun } from './runs-api';

const LocationPicker = ({
  open,
  chosen,
  toggle,
}: {
  open: boolean;
  chosen: ReadonlySet<string>;
  toggle: (id: string) => void;
}) => {
  const locations = useRunLocations(open);

  if (locations.isPending)
    return (
      <Flex direction="column" gap="1">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} h="9" rounded="lg" />
        ))}
      </Flex>
    );

  if (locations.isError || !locations.data.length)
    return (
      <styled.p fontSize="1" color="text.muted">
        Could not list locations from Distru, so the run covers every location.
      </styled.p>
    );

  return (
    <Flex direction="column" gap="1" p="1.5" rounded="xl" bg="brand.panel.3" data-location-picker="">
      {locations.data.map((location) => (
        <styled.label
          key={location.id}
          display="flex"
          alignItems="center"
          gap="3"
          px="3"
          py="2"
          rounded="lg"
          cursor="pointer"
          bg={{ base: 'background.app', _dark: 'brand.panel.4' }}
          fontSize="1.5"
          data-location={location.name}
        >
          <Checkbox
            checked={chosen.has(location.id)}
            onCheckedChange={() => toggle(location.id)}
            aria-label={location.name}
          />
          <styled.span flex="1" truncate>
            {location.name}
          </styled.span>
        </styled.label>
      ))}
    </Flex>
  );
};

/** Start a restock run, optionally for some locations; on success the run's page opens. */
export const StartRunDialog = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const start = useStartRun();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');

  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChosen(next);
  };

  const submit = () =>
    start.mutate(
      {
        ...(chosen.size ? { locationIds: [...chosen] } : {}),
        ...(note.trim() ? { scenarioNote: note.trim() } : {}),
      },
      { onSuccess: () => onOpenChange(false) },
    );

  return (
    <Dialog open={open} onOpenChange={(next) => !start.isPending && onOpenChange(next)}>
      <DialogContent
        aria-label="Start a restock run"
        showCloseIcon={false}
        w="min(32rem, calc(100vw - 2rem))"
        maxH="calc(100dvh - 4rem)"
        p="0"
        rounded="2xl"
        display="flex"
        flexDirection="column"
        data-start-run-dialog=""
      >
        <Flex
          align="center"
          justify="space-between"
          gap="2"
          minH="2.75rem"
          px="4"
          flexShrink="0"
          borderBottom="subtle"
        >
          <DialogTitle minW="0" flex="1" fontSize="1.5" fontWeight="500">
            Start a restock run
          </DialogTitle>
          <DialogClose asChild>
            <Button aria-label="Close" size="icon" h="1.75rem" w="1.75rem" variant="ghost">
              <Icons.close size={14} />
            </Button>
          </DialogClose>
        </Flex>
        <Flex direction="column" gap="4" overflowY="auto" minH="0" flex="1" p="4" fontSize="1.5">
          <styled.p color="text.muted">
            Analysts check each location, planners draft one PO per vendor, compliance and policy review
            them, and the run pauses with one proposal for an approver. Nothing is written before that.
          </styled.p>
          <Box>
            <HStack justify="space-between" mb="2">
              <styled.span fontWeight="500">Locations</styled.span>
              <styled.span fontSize="1" color="text.muted">
                {chosen.size ? `${chosen.size} selected` : 'All locations'}
              </styled.span>
            </HStack>
            <LocationPicker open={open} chosen={chosen} toggle={toggle} />
          </Box>
          <Box>
            <styled.label htmlFor="run-note" display="block" fontWeight="500" mb="2">
              Note for the agents <styled.span color="text.muted" fontWeight="400">(optional)</styled.span>
            </styled.label>
            <styled.textarea
              id="run-note"
              value={note}
              maxLength={1000}
              rows={2}
              placeholder="e.g. Restock anything at risk before the weekend."
              onChange={(event) => setNote(event.target.value)}
              w="full"
              resize="none"
              px="3"
              py="2"
              rounded="lg"
              bg="brand.panel.3"
              outline="none"
              _focusVisible={{ boxShadow: '0 0 0 2px {colors.brand.panel.10}' }}
            />
          </Box>
          {start.isError && (
            <styled.p role="alert" color="text.error" fontSize="1">
              {apiErrorMessage(start.error)}
            </styled.p>
          )}
        </Flex>
        <HStack justify="flex-end" gap="2" px="4" py="3" borderTop="subtle">
          <styled.span mr="auto" fontSize="1" color="text.muted">
            Uses the live model: about $1–3 per run.
          </styled.span>
          <DialogClose asChild>
            <Button variant="ghost" size="sm" disabled={start.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button size="sm" onClick={submit} disabled={start.isPending} data-start-run-submit="">
            {start.isPending ? <Icons.loading size={12} /> : <Icons.play size={12} />}
            Start run
          </Button>
        </HStack>
      </DialogContent>
    </Dialog>
  );
};

/** The button that opens the dialog, for page headers. */
export const StartRunButton = ({ size = 'sm' }: { size?: 'sm' | 'xs' }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size={size} onClick={() => setOpen(true)} data-start-run="">
        <Icons.play size={12} />
        Start restock run
      </Button>
      <StartRunDialog open={open} onOpenChange={setOpen} />
    </>
  );
};
