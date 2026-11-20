// Adapted from carbonme modules/chats/chat-activity-data.ts and modules/chats/constants.ts.
import type { Icons } from '@ops/ui/icons/base';

import type {
  AgentStep,
  StepActivity,
  StepKind,
  StepRow,
  StepTask,
  TaskTally,
} from './step-types';

/** The status line is announced to screen readers at most this often. */
export const STEP_ANNOUNCE_MS = 5_000;

/** How often the live elapsed time ticks. */
export const STEP_CLOCK_MS = 1_000;

/** Below this the timeline is a phone-width column, where step details wrap and the Tasks tray starts folded. */
export const NARROW_STEPS_QUERY = '(max-width: 559px)';

export const STEP_KIND_ICONS: Record<StepKind, keyof typeof Icons> = {
  agent: 'hierarchy',
  tool: 'integrations',
  workflow: 'workflow',
  review: 'shieldCheck',
  approval: 'checkCircle',
  write: 'database',
  propose: 'editSquare',
  run: 'play',
};

/** What the status line says while a step of each kind runs. */
const STEP_LIVE_COPY: Record<StepKind, (step: AgentStep) => string> = {
  agent: (step) => `${step.object?.name ?? 'An agent'} is working…`,
  tool: (step) => `Calling ${step.object?.name ?? 'a tool'}…`,
  workflow: (step) => `${step.verb} ${step.object?.name ?? ''}…`.trim(),
  review: (step) => `${step.object?.name ?? 'A reviewer'} is reviewing…`,
  approval: () => 'Waiting for a human approver…',
  write: () => 'Writing to Distru…',
  propose: () => 'Creating the proposal…',
  run: () => 'Starting a restock run…',
};

/** "6s", or "1m 04s" from a minute up; under a second reads "<1s". */
export const durationText = (ms: number) => {
  if (ms > 0 && ms < 1_000) return '<1s';

  const seconds = Math.max(0, Math.round(ms / 1_000));

  if (seconds < 60) return `${seconds}s`;

  const rest = String(seconds % 60).padStart(2, '0');

  return `${Math.floor(seconds / 60)}m ${rest}s`;
};

const time = (iso: string | null) => (iso ? Date.parse(iso) : Number.NaN);

const stepsOf = (activity: StepActivity) =>
  activity.items.filter((item): item is AgentStep => item.type === 'step');

/** How long a finished step took; null while it runs or when its times are unknown. */
export const stepDuration = (step: AgentStep) => {
  const ms = time(step.finishedAt) - time(step.startedAt);

  return Number.isFinite(ms) ? durationText(ms) : null;
};

/** The timeline's rows in order, each retry nested under the failed step it tried again. */
export const timelineRows = (activity: StepActivity): StepRow[] => {
  const steps = stepsOf(activity);

  const rows: StepRow[] = [];

  for (const item of activity.items) {
    if (item.type === 'thinking') rows.push({ kind: 'thinking', note: item });
    else if (!item.retryOf)
      rows.push({
        kind: 'step',
        step: item,
        retries: steps.filter((step) => step.retryOf === item.id),
      });
  }

  return foldRepeatedTools(rows);
};

/** Back-to-back calls of one tool fold into a group from this many on. */
export const FOLD_REPEATED_TOOLS_AT = 2;

const foldKey = (row: StepRow) =>
  row.kind === 'step' && row.step.kind === 'tool' && !row.retries.length && row.step.object ? row.step.object.name : null;

/**
 * Repeated calls of the same tool, back to back and without retries, become one group row (carbonme's chat mockup:
 * many steps of one kind fold into a group, "Read 14 page ranges"); each call stays inside it with its arguments.
 */
export const foldRepeatedTools = (rows: StepRow[]): StepRow[] => {
  const out: StepRow[] = [];
  let index = 0;
  while (index < rows.length) {
    const key = foldKey(rows[index]!);
    let end = index + 1;
    while (key && end < rows.length && foldKey(rows[end]!) === key) end++;
    const run = rows.slice(index, end);
    if (key && run.length >= FOLD_REPEATED_TOOLS_AT) {
      const steps = run.flatMap((row) => (row.kind === 'step' ? [row.step] : []));
      out.push({ kind: 'group', id: `group:${steps[0]!.id}`, steps });
    } else out.push(...run);
    index = end;
  }
  return out;
};

/** A group's status: running while any call runs, failed if one failed, else done. */
export const groupStatus = (steps: readonly AgentStep[]): AgentStep['status'] =>
  steps.some((step) => step.status === 'running')
    ? 'running'
    : steps.some((step) => step.status === 'failed')
      ? 'failed'
      : steps.some((step) => step.status === 'stopped')
        ? 'stopped'
        : 'done';

/** The newest note, which stays open while the others fold to one line. */
export const newestNoteId = (activity: StepActivity) =>
  activity.items.findLast((item) => item.type === 'thinking')?.id ?? null;

const stepCount = (activity: StepActivity) =>
  stepsOf(activity).filter((step) => !step.retryOf).length;

/** The kinds of step the run used, in the order it first used them. */
export const stepKinds = (activity: StepActivity): StepKind[] => [
  ...new Set(stepsOf(activity).map((step) => step.kind)),
];

/** Failed steps whose newest retry did not fail, and failed steps no retry recovered. */
export const retryTally = (activity: StepActivity) => {
  const steps = stepsOf(activity);

  const failed = steps.filter(
    (step) => step.status === 'failed' && !step.retryOf,
  );

  const retried = failed.filter((step) => {
    const newest = steps.findLast((retry) => retry.retryOf === step.id);

    return newest !== undefined && newest.status !== 'failed';
  });

  return { retried: retried.length, failed: failed.length - retried.length };
};

const workedMs = (activity: StepActivity, now: number) => {
  const starts = [time(activity.startedAt), time(stepsOf(activity)[0]?.startedAt ?? null)].filter(Number.isFinite);

  const end = time(activity.answeredAt ?? activity.endedAt);

  return (Number.isFinite(end) ? end : now) - (starts.length ? Math.min(...starts) : now);
};

export const plural = (n: number, noun: string) =>
  `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`;

/** "Worked for 2m 18s · 9 steps", or "Stopped after 48s · 4 steps". */
export const summaryText = (activity: StepActivity, now: number) => {
  const verb =
    activity.outcome === 'stopped' || activity.outcome === 'failed'
      ? 'Stopped after'
      : activity.outcome === 'waiting'
        ? 'Paused after'
        : 'Worked for';

  return {
    lead: `${verb} ${durationText(workedMs(activity, now))}`,
    steps: plural(stepCount(activity), 'step'),
  };
};

/** Elapsed time since the run started, for the working header and the status line. */
export const elapsedText = (activity: StepActivity, now: number) =>
  durationText(now - time(activity.startedAt));

/** What the agents are doing now: the running step in words, or thinking between steps. */
export const liveStatusText = (activity: StepActivity) => {
  const last = stepsOf(activity).findLast((step) => step.status === 'running');

  if (!last) return 'Thinking…';

  return STEP_LIVE_COPY[last.kind](last);
};

/** Whether the run is still working, as opposed to paused, answered or ended. */
export const activityWorking = (activity: StepActivity) =>
  activity.outcome === 'working';

export const taskTally = (tasks: readonly StepTask[]): TaskTally => ({
  done: tasks.filter((task) => task.status === 'done').length,
  total: tasks.length,
  current:
    tasks.find(
      (task) => task.status === 'active' || task.status === 'blocked',
    ) ?? null,
});

/** A task added after the list began reads as new until another step goes by. */
export const isNewTask = (task: StepTask, activity: StepActivity) =>
  task.addedAt > 0 &&
  task.status !== 'done' &&
  activity.items.length - task.addedAt <= 1;

/** "$0.2178" under a dollar, "$2.69" above it. */
export const formatCost = (usd: number) =>
  usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;

/** "623k", "8.1k", "940". */
export const formatTokens = (tokens: number) => {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;

  if (tokens >= 10_000) return `${Math.round(tokens / 1_000)}k`;

  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;

  return String(tokens);
};

/** Pretty JSON for a well, capped so a huge tool result never freezes the page (carbonme formatToolValue). */
export const formatToolValue = (value: unknown) => {
  if (value === null || value === undefined) return '';

  const text =
    typeof value === 'string' ? value : JSON.stringify(value, null, 2);

  if (text.length <= 20_000) return text;

  return `${text.slice(0, 20_000)}\n… ${(text.length - 20_000).toLocaleString()} more characters`;
};

/** Whether a tool result carries ERP free text the connector flagged as instruction-like. */
export const hasSuspiciousText = (value: unknown, depth = 0): boolean => {
  if (depth > 8 || value === null || typeof value !== 'object') return false;

  if (Array.isArray(value))
    return value.some((item) => hasSuspiciousText(item, depth + 1));

  const record = value as Record<string, unknown>;

  if ('untrusted_text' in record && record.suspicious === true) return true;

  return Object.values(record).some((item) =>
    hasSuspiciousText(item, depth + 1),
  );
};
