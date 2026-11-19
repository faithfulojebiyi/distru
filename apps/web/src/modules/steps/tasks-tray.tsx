// Adapted from carbonme modules/chats/chat-tasks-tray.tsx (the Tasks tray over the composer).
import { useState, useSyncExternalStore } from 'react';
import { Box, styled } from '@ops/ui/jsx';
import { css } from '@ops/ui/css';
import { Icons } from '@ops/ui/icons/base';

import {
  NARROW_STEPS_QUERY as NARROW_CHAT_QUERY,
  isNewTask,
  taskTally,
} from './step-activity-data';
import type { StepActivity as ChatActivity, StepTask as ChatTask } from './step-types';

const subscribeNarrow = (change: () => void) => {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};

  const query = window.matchMedia(NARROW_CHAT_QUERY);

  query.addEventListener('change', change);

  return () => query.removeEventListener('change', change);
};

const narrowNow = () =>
  typeof window !== 'undefined' &&
  Boolean(window.matchMedia?.(NARROW_CHAT_QUERY).matches);

/** Whether the page is phone width, where the tray starts folded to one line. */
const useNarrow = () =>
  useSyncExternalStore(subscribeNarrow, narrowNow, () => false);

/** "Done: Pull the requirements" as each task finishes, read to screen readers only; tasks already done when the tray
 * appeared are not read again. */
const useTaskAnnouncement = (tasks: readonly ChatTask[]) => {
  const [initial] = useState(
    () =>
      new Set(
        tasks.filter((task) => task.status === 'done').map((task) => task.id),
      ),
  );

  const finished = tasks.filter(
    (task) => task.status === 'done' && !initial.has(task.id),
  );

  const last = finished.at(-1);

  return last ? `Done: ${last.title}` : '';
};

const TaskBox = ({ status }: { status: ChatTask['status'] }) => {
  switch (status) {
    case 'done':
      return <Icons.checkCircle size={14} color="status.good.fg" />;
    case 'active':
      return (
        <styled.span
          position="relative"
          w="13px"
          h="13px"
          rounded="full"
          boxShadow="inset 0 0 0 1.5px {colors.chat.violet}"
          _after={{
            content: '""',
            position: 'absolute',
            inset: '3.5px',
            rounded: 'full',
            bg: 'chat.violet',
          }}
        />
      );
    case 'blocked':
      return <Icons.pause size={14} color="status.warn.fg" />;
    case 'todo':
      return (
        <styled.span
          w="13px"
          h="13px"
          rounded="full"
          boxShadow="inset 0 0 0 1.5px {colors.brand.panel.20}"
        />
      );
  }
};

const TaskItem = ({ task, isNew }: { task: ChatTask; isNew: boolean }) => (
  <styled.li
    display="grid"
    gridTemplateColumns="16px minmax(0, 1fr) auto"
    gap="2"
    alignItems="center"
    minH="26px"
    className={TASK_COLORS[task.status]}
    fontWeight={task.status === 'active' ? '500' : undefined}
    animation="chatRise"
    _motionReduce={{ animation: 'none' }}
    data-task={task.status}
  >
    <styled.span w="4" h="4" display="grid" placeItems="center">
      <TaskBox status={task.status} />
    </styled.span>
    <styled.span
      truncate
      minW="0"
      textDecoration={task.status === 'done' ? 'line-through' : undefined}
      textDecorationColor="brand.panel.20"
    >
      {task.title}
    </styled.span>
    {isNew && (
      <styled.span
        display="inline-flex"
        alignItems="center"
        h="18px"
        px="7px"
        rounded="full"
        fontSize="0.719"
        fontWeight="500"
        bg="chat.infoBg"
        color="chat.infoFg"
      >
        New
      </styled.span>
    )}
  </styled.li>
);

/** Each task state's text colour as a class, since Panda builds classes only from colours it can read in the source. */
const TASK_COLORS: Record<ChatTask['status'], string> = {
  todo: css({ color: 'chat.text2' }),
  active: css({ color: 'text.app' }),
  done: css({ color: 'chat.muted' }),
  blocked: css({ color: 'chat.text2' }),
};

/** The tray's header: open, "Tasks 2 of 5"; folded, "Tasks 6 of 6 done" with the current task beside it. */
const TrayHeader = ({
  tasks,
  open,
  toggle,
}: {
  tasks: readonly ChatTask[];
  open: boolean;
  toggle: () => void;
}) => {
  const tally = taskTally(tasks);

  const Chevron = open ? Icons.caretDown : Icons.caretUp;

  const Mark = open ? Icons.checklist : Icons.checkCircle;

  const current = !open && tally.done < tally.total ? tally.current : null;

  return (
    <styled.button
      type="button"
      aria-expanded={open}
      onClick={toggle}
      display="flex"
      alignItems="center"
      gap="2"
      h="26px"
      w="full"
      color="chat.text2"
      minW="0"
      textAlign="start"
      rounded="md"
      _focusVisible={{
        outline: 'none',
        boxShadow: '0 0 0 3px {colors.brand.panel.10}',
      }}
    >
      <Mark size={14} />
      <styled.b fontWeight="500" color="text.app">
        Tasks
      </styled.b>
      <styled.span color="chat.muted" fontVariantNumeric="tabular-nums">
        {tally.done} of {tally.total}
        {open ? '' : ' done'}
      </styled.span>
      {current && (
        <styled.span
          color="chat.muted"
          truncate
          minW="0"
          flex="1"
          textAlign="end"
        >
          {current.title}
        </styled.span>
      )}
      <styled.span
        color="chat.muted"
        flexShrink="0"
        ml={current ? '0' : 'auto'}
      >
        <Chevron size={12} />
      </styled.span>
    </styled.button>
  );
};

/** The run's stages as Tasks: open while it works, one line once all are done or at phone width. `docked` sits it on
 * a composer as in carbonme; undocked it is a standalone grey card (the Runs page). */
export const TasksTray = ({
  tasks,
  activity,
  docked = true,
}: {
  tasks: readonly ChatTask[];
  activity: ChatActivity;
  docked?: boolean;
}) => {
  const narrow = useNarrow();

  const allDone = tasks.every((task) => task.status === 'done');

  const [choice, setChoice] = useState<boolean | null>(null);

  const open = choice ?? (!allDone && !narrow);

  const said = useTaskAnnouncement(tasks);

  return (
    <Box
      mx={docked ? { base: '2.5', md: '3.5' } : undefined}
      mb={docked ? '-3.5' : undefined}
      pt="2"
      px="3.5"
      pb={docked ? '22px' : '2.5'}
      roundedTop="chatCard"
      roundedBottom={docked ? undefined : 'chatCard'}
      bg="brand.panel.4"
      fontSize="1.5"
      animation="chatRise"
      _motionReduce={{ animation: 'none' }}
      role="group"
      aria-label="Tasks"
      data-testid="tasks-tray"
    >
      <TrayHeader tasks={tasks} open={open} toggle={() => setChoice(!open)} />
      {open && (
        <styled.ul
          display="flex"
          flexDirection="column"
          gap="1px"
          mt="1"
          p="0"
          listStyle="none"
        >
          {tasks.map((task) => (
            <TaskItem
              key={task.id}
              task={task}
              isNew={isNewTask(task, activity)}
            />
          ))}
        </styled.ul>
      )}
      <styled.span srOnly role="status" aria-live="polite">
        {said}
      </styled.span>
    </Box>
  );
};
