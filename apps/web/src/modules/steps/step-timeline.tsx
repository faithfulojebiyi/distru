// Adapted from carbonme modules/chats/chat-step-timeline.tsx (live steps: header, step rows, Thinking notes, status line).
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Box, Flex, HStack, styled } from '@ops/ui/jsx';
import { css } from '@ops/ui/css';
import { ThinkingOrb } from '@ops/ui/blocks/thinking-orb';
import { Icons } from '@ops/ui/icons/base';

import {
  STEP_ANNOUNCE_MS,
  STEP_CLOCK_MS,
  STEP_KIND_ICONS,
  activityWorking,
  durationText,
  elapsedText,
  formatCost,
  formatTokens,
  formatToolValue,
  groupStatus,
  liveStatusText,
  newestNoteId,
  plural,
  retryTally,
  stepDuration,
  stepKinds,
  summaryText,
  timelineRows,
} from './step-activity-data';
import type {
  AgentStep,
  StepActivity,
  StepNote,
  StepRow,
  StepToolCall,
} from './step-types';

/** The user's open or closed choice for each run's timeline, kept while the page lives. */
const timelineChoices = new Map<string, boolean>();

/** Below 560px the detail wraps under the label and durations hide. */
const narrow = '@container (max-width: 559px)';

const stepRowClass = css({
  display: 'grid',
  gridTemplateColumns: '20px minmax(0, 1fr) auto',
  columnGap: '2',
  alignItems: 'center',
  minH: '30px',
  py: '1',
  px: '2',
  mx: '-2',
  rounded: 'lg',
  minW: '0',
  w: 'calc(100% + 1rem)',
  textAlign: 'start',
  animation: 'chatStep',
  _motionReduce: { animation: 'none' },
});

const clickableClass = css({
  cursor: 'pointer',
  _hover: { bg: 'brand.panel.4' },
  _focusVisible: {
    outline: 'none',
    boxShadow: '0 0 0 3px {colors.brand.panel.10}',
  },
});

const shimmerClass = css({
  color: 'transparent',
  backgroundImage:
    'linear-gradient(90deg, {colors.text.app} 0%, {colors.text.app} 40%, {colors.chat.faint} 50%, {colors.text.app} 60%, {colors.text.app} 100%)',
  backgroundSize: '250% 100%',
  backgroundClip: 'text',
  animation: 'chatShimmer',
  _motionReduce: { animation: 'none', color: 'text.app' },
});

/** The time now, ticking each second while the run works. */
const useNow = (ticking: boolean) => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!ticking) return;

    const timer = setInterval(() => setNow(Date.now()), STEP_CLOCK_MS);

    return () => clearInterval(timer);
  }, [ticking]);

  return now;
};

/** The status line's words for screen readers, changed at most every five seconds. */
const useThrottledAnnouncement = (text: string) => {
  const [said, setSaid] = useState(text);

  useEffect(() => {
    const timer = setTimeout(() => setSaid(text), STEP_ANNOUNCE_MS);

    return () => clearTimeout(timer);
  }, [text]);

  return said;
};

/** An agent's mark: the small violet orb the mockup gives a hand-off's target. */
export const AgentOrb = ({ size = 14 }: { size?: number }) => (
  <styled.span
    aria-hidden
    display="inline-block"
    flexShrink="0"
    rounded="full"
    style={{ width: size, height: size }}
    backgroundImage="radial-gradient(circle at 35% 30%, #c7d2fe 0%, #818cf8 45%, #4f46e5 100%)"
  />
);

/** The ERP returned text that reads like instructions; the agents treat it as data, and so should you. */
export const SuspiciousChip = () => (
  <styled.span
    display="inline-flex"
    alignItems="center"
    gap="1"
    h="18px"
    px="7px"
    rounded="full"
    fontSize="0.719"
    fontWeight="500"
    flexShrink="0"
    bg="status.warn.bg"
    color="status.warn.fg"
    title="This result contains ERP free text that looks like instructions. Agents treat it as data only."
    data-suspicious=""
  >
    <Icons.warn size={10} />
    Suspicious text
  </styled.span>
);

const StepObject = ({ step }: { step: AgentStep }) => {
  const { object } = step;

  if (!object) return null;

  return (
    <styled.span
      display="inline-flex"
      alignItems="center"
      gap="5px"
      color="text.app"
      fontWeight="500"
      flexShrink="0"
      minW="0"
      maxW="60%"
      className={step.status === 'running' ? shimmerClass : undefined}
    >
      {object.agent ? <AgentOrb /> : null}
      <styled.span truncate>{object.name}</styled.span>
    </styled.span>
  );
};

const StepIcon = ({ step }: { step: AgentStep }) => {
  if (step.status === 'failed') return <Icons.alertCircle size={14} />;

  if (step.status === 'waiting') return <Icons.pause size={14} />;

  const Icon = Icons[STEP_KIND_ICONS[step.kind]];

  return <Icon size={14} />;
};

const FailedBadge = () => (
  <styled.span
    display="inline-flex"
    alignItems="center"
    h="18px"
    px="7px"
    rounded="full"
    fontSize="0.719"
    fontWeight="500"
    bg="status.bad.bg"
    color="status.bad.fg"
  >
    Failed
  </styled.span>
);

/** Tokens and cost beside the duration, hidden at phone width. */
const UsageMeta = ({ step }: { step: AgentStep }) => {
  const parts = [
    step.tokens ? `${formatTokens(step.tokens)} tok` : null,
    step.costUsd ? formatCost(step.costUsd) : null,
  ].filter(Boolean);

  if (!parts.length) return null;

  return (
    <styled.span css={{ [narrow]: { display: 'none' } }} data-step-usage="">
      {parts.join(' · ')}
    </styled.span>
  );
};

/** A step's right edge: a spinner while it runs, Failed, or its usage, duration and a chevron when it opens. */
const StepMeta = ({
  step,
  expandable,
  expanded,
}: {
  step: AgentStep;
  expandable: boolean;
  expanded: boolean;
}) => {
  const duration = stepDuration(step);

  const Chevron = expanded ? Icons.caretUp : Icons.caretDown;

  return (
    <HStack
      gap="1.5"
      color={step.status === 'running' ? 'chat.muted' : 'chat.faint'}
      fontSize="1"
      fontVariantNumeric="tabular-nums"
      whiteSpace="nowrap"
      pl="2"
    >
      {step.status === 'running' && (
        <Icons.loading size={14} aria-label="Running" />
      )}
      {step.status === 'failed' && <FailedBadge />}
      {step.status === 'stopped' && <span>Stopped</span>}
      {step.status === 'waiting' && <span>Waiting</span>}
      {step.status !== 'running' && <UsageMeta step={step} />}
      {step.status === 'done' && duration && (
        <styled.span css={{ [narrow]: { display: 'none' } }}>
          {duration}
        </styled.span>
      )}
      {expandable && step.status !== 'running' && <Chevron size={12} />}
    </HStack>
  );
};

const StepLabel = ({ step }: { step: AgentStep }) => (
  <styled.span
    display="flex"
    alignItems="center"
    gap="1.5"
    minW="0"
    whiteSpace="nowrap"
    css={{ [narrow]: { flexWrap: 'wrap', rowGap: '0', whiteSpace: 'normal' } }}
  >
    <styled.span
      fontWeight="500"
      color={step.status === 'failed' ? 'status.bad.fg' : 'chat.text2'}
      flexShrink="0"
      className={step.status === 'running' ? shimmerClass : undefined}
    >
      {step.verb}
    </styled.span>
    <StepObject step={step} />
    {step.detail && (
      <styled.span
        color="chat.muted"
        truncate
        minW="0"
        css={{ [narrow]: { flexBasis: '100%' } }}
      >
        {step.detail}
      </styled.span>
    )}
    {step.suspicious && <SuspiciousChip />}
  </styled.span>
);

export const Well = ({
  label,
  children,
  mono = true,
}: {
  label: string;
  children: string;
  mono?: boolean;
}) => (
  <Box
    bg="brand.panel.3"
    rounded="chatWell"
    px="3"
    py="2"
    fontFamily={mono ? 'mono' : 'sans'}
    fontSize="1"
    lineHeight="1.55"
    whiteSpace="pre-wrap"
    overflowWrap="anywhere"
    color="chat.text2"
    maxH="18rem"
    overflowY="auto"
  >
    <styled.span
      display="block"
      fontFamily="sans"
      fontSize="0.719"
      color="chat.muted"
      mb="0.5"
    >
      {label}
    </styled.span>
    {children}
  </Box>
);

const hasMore = (step: AgentStep) =>
  Boolean(step.note) ||
  step.input !== undefined ||
  step.output !== undefined;

/** What an open row shows: the agent's summary or the critic's reasons, and the call's input and output. */
const StepMore = ({
  step,
  expanded,
}: {
  step: AgentStep;
  expanded: boolean;
}) => {
  if (!expanded) return null;

  return (
    <Flex direction="column" gap="0.5" mt="1">
      {step.note && (
        <Well label="Summary" mono={false}>
          {step.note}
        </Well>
      )}
      {step.input !== undefined && (
        <Well label="Input">{formatToolValue(step.input) || '{}'}</Well>
      )}
      {step.output !== undefined && (
        <Well label="Result">{formatToolValue(step.output) || '—'}</Well>
      )}
    </Flex>
  );
};

const CallIcon = ({ call }: { call: StepToolCall }) => {
  switch (call.status) {
    case 'running':
      return <Icons.loading size={12} color="chat.muted" />;
    case 'failed':
      return <Icons.alertCircle size={12} color="status.bad.fg" />;
    default:
      return <Icons.checkCircle size={12} color="chat.muted" />;
  }
};

/** One tool call inside an agent's sub-card, as carbonme's retry line: icon, tool, duration. */
const CallLine = ({ call }: { call: StepToolCall }) => {
  const [open, setOpen] = useState(false);

  const more = call.input !== undefined || call.output !== undefined;

  const body = (
    <>
      <CallIcon call={call} />
      <styled.span
        display="flex"
        gap="1.5"
        alignItems="center"
        minW="0"
        color={call.status === 'running' ? 'text.app' : undefined}
      >
        <styled.span truncate fontFamily="mono" fontSize="1">
          {call.tool}
        </styled.span>
        {call.error && (
          <styled.span color="status.bad.fg" truncate>
            {call.error}
          </styled.span>
        )}
        {call.suspicious && <SuspiciousChip />}
      </styled.span>
      <styled.span
        color="chat.faint"
        fontSize="1"
        fontVariantNumeric="tabular-nums"
        display="inline-flex"
        gap="1"
        alignItems="center"
      >
        {call.durationMs !== null ? durationText(call.durationMs) : ''}
        {more && (open ? <Icons.caretUp size={10} /> : <Icons.caretDown size={10} />)}
      </styled.span>
    </>
  );

  const shape = {
    display: 'grid',
    gridTemplateColumns: '16px minmax(0, 1fr) auto',
    gap: '2',
    alignItems: 'center',
    minH: '26px',
    color: 'chat.text2',
    minW: '0',
    w: 'full',
    textAlign: 'start',
  } as const;

  return (
    <styled.li listStyle="none" minW="0" data-tool-call={call.tool}>
      {more ? (
        <styled.button
          type="button"
          {...shape}
          cursor="pointer"
          rounded="md"
          _hover={{ color: 'text.app' }}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {body}
        </styled.button>
      ) : (
        <Box {...shape}>{body}</Box>
      )}
      {open && (
        <Flex direction="column" gap="0.5" ml="6" mb="1">
          {call.input !== undefined && (
            <Well label="Input">{formatToolValue(call.input) || '{}'}</Well>
          )}
          {call.output !== undefined && (
            <Well label="Result">{formatToolValue(call.output) || '—'}</Well>
          )}
        </Flex>
      )}
    </styled.li>
  );
};

/** Under an agent hand-off: the agent's pill (carbonme's workflow pill), opening to its tool calls. */
const AgentCard = ({ step }: { step: AgentStep }) => {
  const [open, setOpen] = useState(false);

  if (step.kind !== 'agent' && step.kind !== 'review') return null;

  if (!step.calls.length) return null;

  const failed = step.calls.filter((call) => call.status === 'failed').length;

  return (
    <Box
      mt="0.5"
      rounded="chatCard"
      bg="brand.panel.3"
      minW="0"
      data-agent-card={step.object?.agent ?? ''}
    >
      <styled.button
        type="button"
        display="flex"
        alignItems="center"
        gap="2"
        w="full"
        minH="9"
        px="3"
        rounded="chatCard"
        textAlign="start"
        cursor="pointer"
        className={clickableClass}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <AgentOrb size={18} />
        <styled.span fontWeight="500" color="text.app" flexShrink="0">
          {step.object?.name}
        </styled.span>
        <styled.span color="chat.muted" truncate minW="0">
          {plural(step.calls.length, 'tool call')}
          {failed ? ` · ${failed} failed` : ''}
        </styled.span>
        <styled.span color="chat.faint" ml="auto" display="flex">
          {open ? <Icons.caretDown size={12} /> : <Icons.caretRight size={12} />}
        </styled.span>
      </styled.button>
      {open && (
        <styled.ul display="flex" flexDirection="column" px="3" pb="2" m="0">
          {step.calls.map((call) => (
            <CallLine key={call.id} call={call} />
          ))}
        </styled.ul>
      )}
    </Box>
  );
};

const RetryLine = ({ step }: { step: AgentStep }) => (
  <Box
    display="grid"
    gridTemplateColumns="16px minmax(0, 1fr) auto"
    gap="2"
    alignItems="center"
    h="26px"
    color="chat.text2"
    minW="0"
  >
    {step.status === 'failed' ? (
      <Icons.alertCircle size={12} color="status.bad.fg" />
    ) : (
      <Icons.checkCircle size={12} color="chat.muted" />
    )}
    <styled.span truncate>
      {[step.detail, step.object?.name].filter(Boolean).join(' · ') ||
        step.verb}
    </styled.span>
    <styled.span
      color="chat.faint"
      fontSize="1"
      fontVariantNumeric="tabular-nums"
    >
      {step.status === 'running' ? '' : stepDuration(step)}
    </styled.span>
  </Box>
);

/** The row's main line: a button when it opens in place, plain text otherwise. */
const StepLine = ({
  step,
  expanded,
  activate,
}: {
  step: AgentStep;
  expanded: boolean;
  activate: (() => void) | null;
}) => {
  const body = (
    <>
      <styled.span
        w="5"
        h="5"
        display="grid"
        placeItems="center"
        color={step.status === 'failed' ? 'status.bad.fg' : 'chat.muted'}
      >
        <StepIcon step={step} />
      </styled.span>
      <StepLabel step={step} />
      <StepMeta step={step} expandable={Boolean(activate)} expanded={expanded} />
    </>
  );

  if (!activate) return <div className={stepRowClass}>{body}</div>;

  return (
    <styled.button
      type="button"
      className={`${stepRowClass} ${clickableClass}`}
      aria-expanded={expanded}
      onClick={activate}
    >
      {body}
    </styled.button>
  );
};

const StepRowView = ({
  row,
  slot,
}: {
  row: Extract<StepRow, { kind: 'step' }>;
  slot: ReactNode;
}) => {
  const { step } = row;

  const [expanded, setExpanded] = useState(false);

  const activate = hasMore(step) ? () => setExpanded(!expanded) : null;

  return (
    <styled.li
      listStyle="none"
      minW="0"
      data-step={step.kind}
      data-status={step.status}
    >
      <StepLine step={step} expanded={expanded} activate={activate} />
      <Flex direction="column" gap="0.5" ml="7" minW="0">
        {step.error && (
          <styled.span color="status.bad.fg" fontSize="1.25" role="alert">
            {step.error}
          </styled.span>
        )}
        {row.retries.map((retry) => (
          <RetryLine key={retry.id} step={retry} />
        ))}
        <StepMore step={step} expanded={expanded} />
        <AgentCard step={step} />
        {slot}
      </Flex>
    </styled.li>
  );
};

/**
 * Back-to-back calls of one tool as one row, "Called distru.velocity_report 4 times" (carbonme's chat mockup: many
 * steps of one kind fold into a group). It opens to the calls themselves, each with its arguments as the detail.
 */
const GroupRowView = ({ row, slots }: { row: Extract<StepRow, { kind: 'group' }>; slots?: Record<string, ReactNode> }) => {
  const [expanded, setExpanded] = useState(false);
  const first = row.steps[0]!;
  const status = groupStatus(row.steps);
  const summary: AgentStep = {
    ...first,
    id: row.id,
    status,
    detail: `${row.steps.length} times`,
    finishedAt: status === 'running' ? null : (row.steps.at(-1)?.finishedAt ?? first.finishedAt),
    tokens: null,
    costUsd: null,
  };
  return (
    <styled.li listStyle="none" minW="0" data-step-group={first.object?.name ?? ''} data-status={status} data-count={row.steps.length}>
      <StepLine step={summary} expanded={expanded} activate={() => setExpanded(!expanded)} />
      {expanded && (
        <styled.ol display="flex" flexDirection="column" gap="1px" ml="7" p="0" minW="0" data-step-group-calls="">
          {row.steps.map((step) => (
            <StepRowView key={step.id} row={{ kind: 'step', step, retries: [] }} slot={slots?.[step.id] ?? null} />
          ))}
        </styled.ol>
      )}
    </styled.li>
  );
};

/** A note between steps: one line when folded, the whole note when open (carbonme's Thinking row). */
const ThinkingRow = ({
  note,
  open,
  toggle,
}: {
  note: StepNote;
  open: boolean;
  toggle: () => void;
}) => {
  const Chevron = open ? Icons.caretUp : Icons.caretDown;

  return (
    <styled.li
      listStyle="none"
      minW="0"
      data-thinking={open ? 'open' : 'folded'}
    >
      <styled.button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className={clickableClass}
        display="grid"
        gridTemplateColumns="20px minmax(0, 1fr) auto"
        columnGap="2"
        alignItems="start"
        py="5px"
        px="2"
        mx="-2"
        w="calc(100% + 1rem)"
        rounded="lg"
        textAlign="start"
        animation="chatStep"
        _motionReduce={{ animation: 'none' }}
      >
        <styled.span
          w="5"
          h="5"
          display="grid"
          placeItems="center"
          color="chat.faint"
        >
          <Icons.bulb size={14} />
        </styled.span>
        <styled.span
          color="chat.muted"
          fontSize="1.5"
          lineHeight="20px"
          minW="0"
          whiteSpace={open ? 'pre-line' : 'nowrap'}
          overflow={open ? undefined : 'hidden'}
          textOverflow={open ? undefined : 'ellipsis'}
        >
          <styled.span color="chat.text2" fontWeight="500" mr="1.5">
            {note.label}
          </styled.span>
          {note.text}
        </styled.span>
        <styled.span color="chat.faint" mt="3px">
          <Chevron size={12} />
        </styled.span>
      </styled.button>
    </styled.li>
  );
};

const TimelineList = ({
  activity,
  slots,
}: {
  activity: StepActivity;
  slots?: Record<string, ReactNode>;
}) => {
  const [notes, setNotes] = useState<Record<string, boolean>>({});

  const newest = newestNoteId(activity);

  const rows = timelineRows(activity);

  return (
    <styled.ol
      display="flex"
      flexDirection="column"
      gap="1px"
      mt="0.5"
      p="0"
      minW="0"
    >
      {rows.map((row) =>
        row.kind === 'thinking' ? (
          <ThinkingRow
            key={row.note.id}
            note={row.note}
            open={notes[row.note.id] ?? row.note.id === newest}
            toggle={() =>
              setNotes({
                ...notes,
                [row.note.id]: !(notes[row.note.id] ?? row.note.id === newest),
              })
            }
          />
        ) : row.kind === 'group' ? (
          <GroupRowView key={row.id} row={row} slots={slots} />
        ) : (
          <StepRowView
            key={row.step.id}
            row={row}
            slot={slots?.[row.step.id] ?? null}
          />
        ),
      )}
    </styled.ol>
  );
};

const KindMarks = ({ activity }: { activity: StepActivity }) => (
  <styled.span
    display="inline-flex"
    gap="3px"
    ml="0.5"
    color="chat.faint"
    aria-hidden
  >
    {stepKinds(activity).map((kind) => {
      const Icon = Icons[STEP_KIND_ICONS[kind]];

      return <Icon key={kind} size={12} />;
    })}
  </styled.span>
);

const headerClass = css({
  display: 'inline-flex',
  alignSelf: 'flex-start',
  alignItems: 'center',
  gap: '1.5',
  h: '7',
  px: '2',
  ml: '-2',
  rounded: 'lg',
  color: 'chat.muted',
  fontSize: '1.5',
  maxW: '100%',
  _hover: { bg: 'brand.panel.4', color: 'text.app' },
  _focusVisible: {
    outline: 'none',
    boxShadow: '0 0 0 3px {colors.brand.panel.10}',
  },
});

/** The line the timeline folds into: how long the run worked, how many steps, and the kinds it used. */
const TimelineHeader = ({
  activity,
  working,
  expanded,
  now,
  toggle,
  listId,
}: {
  activity: StepActivity;
  working: boolean;
  expanded: boolean;
  now: number;
  toggle: () => void;
  listId: string;
}) => {
  const Chevron = expanded ? Icons.caretUp : Icons.caretDown;

  if (working)
    return (
      <button
        type="button"
        className={headerClass}
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={toggle}
      >
        <styled.b fontWeight="500" color="chat.text2">
          Working
        </styled.b>
        · {elapsedText(activity, now)}
        <Chevron size={12} />
      </button>
    );

  const summary = summaryText(activity, now);

  const tally = retryTally(activity);

  return (
    <button
      type="button"
      className={headerClass}
      aria-expanded={expanded}
      aria-controls={listId}
      onClick={toggle}
      data-testid="steps-summary"
    >
      <Icons.clock size={12} />
      <styled.b fontWeight="500" color="chat.text2">
        {summary.lead}
      </styled.b>
      · {summary.steps}
      {tally.failed > 0 && (
        <styled.span color="status.bad.fg">
          · {tally.failed} {tally.failed === 1 ? 'step' : 'steps'} failed
        </styled.span>
      )}
      {!expanded && <KindMarks activity={activity} />}
      <Chevron size={12} />
    </button>
  );
};

/** What the agents are doing now and for how long; read out at most every five seconds. */
const StepStatusLine = ({
  activity,
  now,
}: {
  activity: StepActivity;
  now: number;
}) => {
  const text = liveStatusText(activity);

  const said = useThrottledAnnouncement(text);

  return (
    <HStack
      gap="2"
      color="chat.muted"
      fontSize="1.5"
      minH="7"
      minW="0"
      data-answer="pending"
    >
      <ThinkingOrb state="working" size={20} />
      <styled.span truncate minW="0" aria-hidden>
        {text}
      </styled.span>
      <styled.span
        color="chat.faint"
        fontVariantNumeric="tabular-nums"
        flexShrink="0"
        aria-hidden
      >
        {elapsedText(activity, now)}
      </styled.span>
      <styled.span srOnly role="status" aria-live="polite">
        {said}
      </styled.span>
    </HStack>
  );
};

/** Open while the run works, folded once it ends, unless the user chose; the choice is kept per run. */
const useTimelineChoice = (key: string, initial: boolean) => {
  const [choice, setChoice] = useState<boolean | null>(
    () => timelineChoices.get(key) ?? null,
  );

  const choose = (open: boolean) => {
    timelineChoices.set(key, open);

    setChoice(open);
  };

  return { choice, expanded: choice ?? initial, choose };
};

/** The run's steps, notes and retries: open while it works, folded into one line once the answer starts unless the
 * user opened it. `defaultOpen` keeps a finished run's trace open, as on the Runs page. */
export const StepTimeline = ({
  activity,
  answering,
  live = false,
  awaiting = false,
  defaultOpen = false,
  slots,
}: {
  activity: StepActivity;
  /** The answer's words are showing, so the timeline folds. */
  answering: boolean;
  /** The run is still going: the header counts up and the status line shows. */
  live?: boolean;
  /** The run waits for a human, who sees why in the card below. */
  awaiting?: boolean;
  defaultOpen?: boolean;
  /** Extra content under a step row, by step id (a link card, a waiting card). */
  slots?: Record<string, ReactNode>;
}) => {
  const listId = useId();

  const working = live && !answering && activityWorking(activity);

  const now = useNow(working);

  const { choice, expanded, choose } = useTimelineChoice(
    activity.startedAt,
    working || defaultOpen,
  );

  if (!activity.items.length)
    return working && !awaiting ? (
      <StepStatusLine activity={activity} now={now} />
    ) : null;

  return (
    <Flex
      direction="column"
      gap="2.5"
      minW="0"
      fontSize="1.5"
      mb={live ? undefined : '2.5'}
      css={{ containerType: 'inline-size' }}
    >
      <Flex
        direction="column"
        minW="0"
        role="region"
        aria-label="Steps"
        data-testid="step-timeline"
        data-expanded={expanded}
        onFocus={() => {
          if (choice === null && working) choose(true);
        }}
      >
        <TimelineHeader
          activity={activity}
          working={working}
          expanded={expanded}
          now={now}
          toggle={() => choose(!expanded)}
          listId={listId}
        />
        <Box id={listId} hidden={!expanded}>
          {expanded && <TimelineList activity={activity} slots={slots} />}
        </Box>
      </Flex>
      {working && !awaiting && <StepStatusLine activity={activity} now={now} />}
    </Flex>
  );
};
