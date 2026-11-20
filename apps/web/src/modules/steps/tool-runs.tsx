// Adapted from carbonme modules/chats/chat-tool-runs.tsx (ToolRunBadge, ToolCallCard, AwaitingApproval).
import { useState } from 'react';
import { Box, Flex, HStack, styled } from '@ops/ui/jsx';

import { Icons } from '@ops/ui/icons/base';
import { AppLogo } from '../settings/connectors-page';
import { formatToolValue } from './step-activity-data';
import { SuspiciousChip } from './step-timeline';

export type ToolRunStatus = 'running' | 'succeeded' | 'failed' | 'awaiting_approval';

/** One tool call as a card shows it: the tool, the connector it ran on, what it ran with and what came back. */
export type ToolRunView = {
  id: string;
  toolName: string;
  title: string | null;
  connectionName: string;
  /** The connector's mark (an integration icon key or a base icon). */
  icon: string;
  status: ToolRunStatus;
  error: string | null;
  input?: unknown;
  output?: unknown;
  suspicious?: boolean;
};

const toolLabel = (run: ToolRunView) => run.title || run.toolName;

/** The warm tint for waiting and for changes; the light amber scale is too yellow. */
const AMBER_TINT = {
  base: 'palette.orange.3',
  _dark: 'palette.amber.3',
} as const;

const RUNNING = { label: 'Running', bg: 'brand.panel.5', color: 'text.label' };

const BADGES: Record<
  ToolRunStatus,
  { label: string; bg: string | typeof AMBER_TINT; color: string; dot?: string }
> = {
  awaiting_approval: {
    label: 'Needs approval',
    bg: AMBER_TINT,
    color: 'palette.amber.11',
    dot: 'palette.amber.9',
  },
  running: RUNNING,
  succeeded: {
    label: 'Done',
    bg: 'palette.green.3',
    color: 'palette.green.11',
    dot: 'palette.green.9',
  },
  failed: {
    label: 'Failed',
    bg: 'brand.error.3',
    color: 'text.error',
    dot: 'brand.error.9',
  },
};

/** A run's status as a tinted pill, never an outline. */
export const ToolRunBadge = ({ status }: { status: ToolRunStatus }) => {
  const badge = BADGES[status];
  return (
    <styled.span
      display="inline-flex"
      alignItems="center"
      gap="1.5"
      flexShrink="0"
      h="18px"
      px="2"
      rounded="full"
      fontSize="1"
      fontWeight="500"
      whiteSpace="nowrap"
      bg={badge.bg}
      color={badge.color}
      data-tool-status={status}
    >
      {status === 'running' ? (
        <Icons.loading size={10} />
      ) : (
        <styled.span
          aria-hidden
          w="1.5"
          h="1.5"
          rounded="full"
          bg={badge.dot}
        />
      )}
      {badge.label}
    </styled.span>
  );
};

/** A call's input or output as text on a white well inside the grey card. */
const ValueBlock = ({ label, value }: { label: string; value: unknown }) => (
  <Box>
    <styled.span fontSize="1" color="text.muted">
      {label}
    </styled.span>
    <styled.pre
      mt="1"
      px="3"
      py="2"
      rounded="lg"
      bg={{ base: 'background.app', _dark: 'brand.panel.4' }}
      fontFamily="mono"
      fontSize="1"
      lineHeight="1.5"
      maxH="16rem"
      overflow="auto"
      whiteSpace="pre-wrap"
      overflowWrap="anywhere"
    >
      {formatToolValue(value) || '—'}
    </styled.pre>
  </Box>
);

/** The app's mark, the tool and the connection it ran on. */
const ToolHeading = ({ run }: { run: ToolRunView }) => (
  <HStack gap="2.5" minW="0" flex="1">
    <AppLogo icon={run.icon} name={run.connectionName} />
    <Box minW="0">
      <styled.p fontSize="1.5" fontWeight="500" truncate>
        {toolLabel(run)}
      </styled.p>
      <styled.p fontSize="1" color="text.muted" truncate>
        {run.connectionName}
      </styled.p>
    </Box>
  </HStack>
);

/** A tool call in the answer: collapsed to its tool and status, opening to what it ran with and why it failed. A
 * recorded call with nothing more to show does not open. */
export const ToolCallCard = ({ run }: { run: ToolRunView }) => {
  const [open, setOpen] = useState(false);
  const failed = run.status === 'failed';
  const details = run.input !== undefined || run.output !== undefined || failed;
  const heading = (
    <>
      <ToolHeading run={run} />
      {run.suspicious && <SuspiciousChip />}
      <ToolRunBadge status={run.status} />
    </>
  );
  return (
    <Box rounded="xl" bg="brand.panel.3" data-tool-run={run.id}>
      {details ? (
        <styled.button
          type="button"
          display="flex"
          alignItems="center"
          gap="2"
          w="full"
          px="3"
          py="2"
          textAlign="left"
          rounded="xl"
          cursor="pointer"
          _focusVisible={{
            outline: '2px solid',
            outlineColor: 'brand.panel.10',
          }}
          aria-expanded={open}
          aria-label={`${toolLabel(run)} in ${run.connectionName}`}
          onClick={() => setOpen((value) => !value)}
        >
          {heading}
          <styled.span
            color="text.muted"
            display="flex"
            transform={open ? 'rotate(180deg)' : undefined}
            transition="transform 0.15s"
          >
            <Icons.caretDown size={12} />
          </styled.span>
        </styled.button>
      ) : (
        <HStack gap="2" px="3" py="2">
          {heading}
        </HStack>
      )}
      {open && details && (
        <Flex direction="column" gap="3" px="3" pb="3" data-tool-details>
          {run.input !== undefined && (
            <ValueBlock label="Input" value={run.input} />
          )}
          {run.output !== undefined && (
            <ValueBlock label="Result" value={run.output} />
          )}
          {failed && (
            <styled.p fontSize="1.5" color="text.error" role="alert">
              {run.error ?? 'The tool call failed.'}
            </styled.p>
          )}
        </Flex>
      )}
    </Box>
  );
};

/** Calls of one tool, in first-call order: one entry per tool, its calls in order. */
export const groupToolRuns = (runs: readonly ToolRunView[]): ToolRunView[][] => {
  const groups = new Map<string, ToolRunView[]>();
  for (const run of runs) groups.set(run.toolName, [...(groups.get(run.toolName) ?? []), run]);
  return [...groups.values()];
};

const groupBadge = (runs: readonly ToolRunView[]): ToolRunStatus =>
  runs.some((run) => run.status === 'running')
    ? 'running'
    : runs.some((run) => run.status === 'awaiting_approval')
      ? 'awaiting_approval'
      : runs.some((run) => run.status === 'failed')
        ? 'failed'
        : 'succeeded';

/**
 * Repeated calls of one tool as one card, "distru.velocity_report · 4 calls" (carbonme's chat mockup folds many
 * steps of one kind into a group). It opens to each call's card.
 */
const ToolRunGroupCard = ({ runs }: { runs: readonly ToolRunView[] }) => {
  const [open, setOpen] = useState(false);
  const first = runs[0]!;
  const suspicious = runs.some((run) => run.suspicious);
  return (
    <Box rounded="xl" bg="brand.panel.3" data-tool-run-group={first.toolName} data-count={runs.length}>
      <styled.button
        type="button"
        display="flex"
        alignItems="center"
        gap="2"
        w="full"
        px="3"
        py="2"
        textAlign="left"
        rounded="xl"
        cursor="pointer"
        _focusVisible={{ outline: '2px solid', outlineColor: 'brand.panel.10' }}
        aria-expanded={open}
        aria-label={`${toolLabel(first)} in ${first.connectionName}, ${runs.length} calls`}
        onClick={() => setOpen((value) => !value)}
      >
        <HStack gap="2.5" minW="0" flex="1">
          <AppLogo icon={first.icon} name={first.connectionName} />
          <Box minW="0">
            <styled.p fontSize="1.5" fontWeight="500" truncate>
              {toolLabel(first)}
              <styled.span color="text.muted" fontWeight="400">
                {` · ${runs.length} calls`}
              </styled.span>
            </styled.p>
            <styled.p fontSize="1" color="text.muted" truncate>
              {first.connectionName}
            </styled.p>
          </Box>
        </HStack>
        {suspicious && <SuspiciousChip />}
        <ToolRunBadge status={groupBadge(runs)} />
        <styled.span color="text.muted" display="flex" transform={open ? 'rotate(180deg)' : undefined} transition="transform 0.15s">
          <Icons.caretDown size={12} />
        </styled.span>
      </styled.button>
      {open && (
        <Flex direction="column" gap="2" px="2" pb="2" data-tool-run-group-calls="">
          {runs.map((run) => (
            <Box key={run.id} rounded="xl" bg={{ base: 'background.app', _dark: 'brand.panel.4' }}>
              <ToolCallCard run={run} />
            </Box>
          ))}
        </Flex>
      )}
    </Box>
  );
};

/** The live answer's tool calls (carbonme ChatToolRuns); repeated calls of one tool fold into one card. */
export const ToolRuns = ({ runs }: { runs: readonly ToolRunView[] }) =>
  runs.length ? (
    <Flex direction="column" gap="2" data-testid="tool-runs">
      {groupToolRuns(runs).map((group) =>
        group.length > 1 ? (
          <ToolRunGroupCard key={group[0]!.id} runs={group} />
        ) : (
          <ToolCallCard key={group[0]!.id} run={group[0]!} />
        ),
      )}
    </Flex>
  ) : null;

/** While a run waits on a human: an amber pill in place of the working indicator. */
export const AwaitingApproval = ({
  label = 'Waiting for approval',
}: {
  label?: string;
}) => (
  <HStack
    gap="2"
    alignSelf="flex-start"
    h="7"
    px="3"
    rounded="full"
    bg={AMBER_TINT}
    color="palette.amber.11"
    fontSize="1.5"
    fontWeight="500"
    role="status"
    data-awaiting-approval
  >
    <styled.span
      aria-hidden
      w="1.5"
      h="1.5"
      rounded="full"
      bg="palette.amber.9"
    />
    {label}
  </HStack>
);
