// Adapted from carbonme modules/chats/types.ts and the ChatStep / ChatActivity schemas (carbonmeAPI.schemas.ts).

/** What a step row did: hand work to an agent, call a tool, run a workflow step, wait for a human, write. */
export type StepKind =
  | 'agent'
  | 'tool'
  | 'workflow'
  | 'review'
  | 'approval'
  | 'write'
  | 'propose'
  | 'run';

export type StepStatus = 'running' | 'done' | 'failed' | 'stopped' | 'waiting';

/** What the step worked on: an agent, a connector, a proposal. */
export type StepObject = {
  name: string;
  /** Agent ids get the orb mark; everything else its icon. */
  agent?: string | null;
};

/** A tool call under an agent hand-off, shown in the hand-off's sub-card. */
export type StepToolCall = {
  id: string;
  tool: string;
  status: 'running' | 'done' | 'failed';
  durationMs: number | null;
  error: string | null;
  input?: unknown;
  output?: unknown;
  /** The output carries ERP free text flagged as instruction-like. */
  suspicious?: boolean;
};

/** One row of the timeline (carbonme ChatStep, without web results and code). */
export type AgentStep = {
  type: 'step';
  id: string;
  kind: StepKind;
  verb: string;
  object: StepObject | null;
  detail: string | null;
  status: StepStatus;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  retryOf: string | null;
  /** Words an open row shows in a grey well, such as an agent's summary or a critic's reasons. */
  note: string | null;
  input?: unknown;
  output?: unknown;
  suspicious?: boolean;
  tokens: number | null;
  costUsd: number | null;
  /** The agent's own tool calls, in a sub-card under the hand-off row. */
  calls: StepToolCall[];
};

/** A short note between steps: the Thinking rows of carbonme, used here for review rounds. */
export type StepNote = {
  type: 'thinking';
  id: string;
  label: string;
  text: string;
  at: string;
};

export type StepTaskStatus = 'todo' | 'active' | 'done' | 'blocked';

export type StepTask = {
  id: string;
  title: string;
  status: StepTaskStatus;
  /** The item count when it was added, so a task added later reads as New for one step. */
  addedAt: number;
};

export type StepOutcome = 'working' | 'waiting' | 'answered' | 'stopped' | 'failed';

/** A run's whole timeline (carbonme ChatActivity). */
export type StepActivity = {
  outcome: StepOutcome;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  items: (AgentStep | StepNote)[];
  tasks: StepTask[];
};

/** A step row with the retries that tried it again nested under it. */
export type StepRow =
  | { kind: 'step'; step: AgentStep; retries: AgentStep[] }
  /** Back-to-back calls of the same tool, folded into one row ("Called distru.velocity_report 4 times"). */
  | { kind: 'group'; id: string; steps: AgentStep[] }
  | { kind: 'thinking'; note: StepNote };

export type TaskTally = {
  done: number;
  total: number;
  current: StepTask | null;
};
