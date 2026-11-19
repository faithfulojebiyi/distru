import type {
  RunAgentCall,
  RunDetail,
  RunStatus,
  RunStep,
} from '../../api/generated/opsAgentAPI.schemas';
import type {
  AgentStep,
  StepActivity,
  StepNote,
  StepOutcome,
  StepStatus,
  StepTask,
} from '../steps/step-types';

/** Each workflow step in words: what the row says while it runs and once it is done. */
const STEP_COPY: Record<string, { done: string; running: string; object?: string; kind: AgentStep['kind'] }> = {
  prepare: { done: 'Resolved', running: 'Resolving', object: 'run scope and vendor lead times', kind: 'workflow' },
  'analyse-location': { done: 'Analysed', running: 'Analysing', object: 'every location', kind: 'agent' },
  'merge-at-risk': { done: 'Merged', running: 'Merging', object: 'at-risk SKUs across locations', kind: 'workflow' },
  'plan-vendor': { done: 'Planned', running: 'Planning', object: 'purchase orders per vendor', kind: 'agent' },
  'collect-plan': { done: 'Collected', running: 'Collecting', object: 'the draft plan', kind: 'workflow' },
  'review-round': { done: 'Reviewed', running: 'Reviewing', object: 'compliance and policy', kind: 'review' },
  propose: { done: 'Created', running: 'Creating', object: 'the proposal', kind: 'propose' },
  'await-decision': { done: 'Approved by', running: 'Waiting for', object: 'a human approver', kind: 'approval' },
  execute: { done: 'Wrote', running: 'Writing', object: 'purchase orders to Distru', kind: 'write' },
  finalize: { done: 'Finished', running: 'Finishing', object: 'the run', kind: 'workflow' },
};

/** The run's stages as the Tasks tray lists them. */
const TASKS: { id: string; title: string; steps: string[] }[] = [
  { id: 'analyse', title: 'Find at-risk SKUs at each location', steps: ['prepare', 'analyse-location', 'merge-at-risk'] },
  { id: 'plan', title: 'Plan purchase orders per vendor', steps: ['plan-vendor', 'collect-plan'] },
  { id: 'review', title: 'Review compliance and policy, revising if needed', steps: ['review-round'] },
  { id: 'propose', title: 'Create one proposal', steps: ['propose'] },
  { id: 'approve', title: 'Wait for a human approver', steps: ['await-decision'] },
  { id: 'execute', title: 'Write to Distru and verify', steps: ['execute', 'finalize'] },
];

const humanize = (id: string) => {
  const words = id.replaceAll('-', ' ').replaceAll('_', ' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

const stepStatusOf = (status: string): StepStatus => {
  switch (status) {
    case 'success':
      return 'done';
    case 'failed':
    case 'tripwire':
    case 'bailed':
      return 'failed';
    case 'running':
    case 'pending':
      return 'running';
    case 'suspended':
    case 'waiting':
    case 'paused':
      return 'waiting';
    case 'canceled':
      return 'stopped';
    default:
      return 'done';
  }
};

export const outcomeOf = (status: RunStatus): StepOutcome => {
  switch (status) {
    case 'running':
    case 'pending':
    case 'waiting':
      return 'working';
    case 'suspended':
    case 'paused':
      return 'waiting';
    case 'success':
    case 'skipped':
      return 'answered';
    case 'canceled':
      return 'stopped';
    default:
      return 'failed';
  }
};

/** "Sacramento Hub has 28 SKUs at 0 available…" → its first sentence. */
const firstSentence = (text: string | null) => {
  if (!text) return null;
  const match = /^(.+?[.!?])(\s|$)/.exec(text.trim());
  return (match?.[1] ?? text).trim();
};

/** "vendor Coastal Cloud Vapes (revision 1)" → what the agent was handed. */
const subjectOf = (call: RunAgentCall) => {
  const match = /^(location|vendor) (.+?)(?: \(revision (\d+)\))?$/.exec(call.label);
  if (match) {
    const [, , name, revision] = match;
    return revision ? `the ${name} revision` : name ?? call.label;
  }
  if (call.agent === 'compliance-reviewer') return `round ${call.round ?? 1} drafts`;
  if (call.agent === 'policy-critic') return 'the policy denial';
  return call.label;
};

const agentStep = (call: RunAgentCall, index: number, stepId: string): AgentStep => {
  const critic = call.agent === 'policy-critic';
  return {
    type: 'step',
    id: `${stepId}:${index}:${call.agent}`,
    kind: call.agent === 'compliance-reviewer' || critic ? 'review' : 'agent',
    verb: critic ? 'Asked' : `Handed ${subjectOf(call)} to`,
    object: { name: call.agentName, agent: call.agent },
    detail: critic ? `why policy denied round ${call.round ?? 1}` : firstSentence(call.summary),
    status: call.status === 'failed' ? 'failed' : 'done',
    startedAt: call.startedAt,
    finishedAt: call.endedAt,
    error: call.error,
    retryOf: null,
    note: call.summary,
    tokens: call.tokens.total || null,
    costUsd: call.costUsd || null,
    calls: call.toolCalls.map((tool, at) => ({
      id: `${stepId}:${index}:${at}`,
      tool: tool.tool,
      status: tool.ok ? 'done' : 'failed',
      durationMs: tool.durationMs,
      error: tool.error,
    })),
  };
};

/** Steps that do nothing when the analysts found nothing to order. */
const SKIPPABLE = new Set(['plan-vendor', 'collect-plan', 'review-round', 'propose', 'await-decision', 'execute']);

const nothingToOrder = (run: RunDetail) => run.result?.status === 'nothing_to_order';

const workflowStep = (step: RunStep, run: RunDetail): AgentStep => {
  const copy = STEP_COPY[step.stepId];
  if (nothingToOrder(run) && SKIPPABLE.has(step.stepId) && step.status === 'success')
    return {
      type: 'step',
      id: step.stepId,
      kind: 'workflow',
      verb: 'Skipped',
      object: copy?.object ? { name: copy.object } : { name: humanize(step.stepId) },
      detail: 'nothing to order',
      status: 'done',
      startedAt: step.startedAt ?? run.createdAt,
      finishedAt: null,
      error: null,
      retryOf: null,
      note: null,
      tokens: null,
      costUsd: null,
      calls: [],
    };
  const status = stepStatusOf(step.status);
  const live = status === 'running' || status === 'waiting';
  const approval = step.stepId === 'await-decision';
  const executed = step.stepId === 'execute' && run.result && typeof run.result.message === 'string';
  return {
    type: 'step',
    id: step.stepId,
    kind: copy?.kind === 'agent' || copy?.kind === 'review' ? 'workflow' : (copy?.kind ?? 'workflow'),
    verb: copy ? (live ? copy.running : copy.done) : humanize(step.stepId),
    object: copy?.object ? { name: copy.object } : null,
    detail:
      step.stepId === 'propose' && run.proposal?.title
        ? run.proposal.title
        : executed
          ? String(run.result?.message)
          : approval && status === 'done'
            ? 'resumed after the decision'
            : step.iterations
              ? `${step.iterations} in parallel`
              : null,
    status,
    startedAt: step.startedAt ?? run.createdAt,
    // Workflow steps replay on resume, so their own times are not how long they took; only agent calls carry real ones.
    finishedAt: null,
    error: step.error,
    retryOf: null,
    note: null,
    tokens: null,
    costUsd: null,
    calls: [],
  };
};

/** The policy critic's verdict for a round, as the round's note. */
const roundNote = (round: number, calls: RunAgentCall[], stepId: string): StepNote => {
  const critic = calls.find((call) => call.agent === 'policy-critic');
  const reviewer = calls.find((call) => call.agent === 'compliance-reviewer');
  const text =
    critic?.summary ?? firstSentence(reviewer?.summary ?? null) ?? 'Compliance and policy review.';
  return {
    type: 'thinking',
    id: `${stepId}:round:${round}`,
    label: `Round ${round}`,
    text: critic ? `Policy Critic: ${text}` : text,
    at: calls[0]?.startedAt ?? '',
  };
};

const byStart = (a: RunAgentCall, b: RunAgentCall) =>
  Date.parse(a.startedAt) - Date.parse(b.startedAt);

/** One workflow step as rows: its agent hand-offs (review rounds as Round notes), or one row when it ran no agent. */
const rowsOfStep = (step: RunStep, run: RunDetail): (AgentStep | StepNote)[] => {
  if (!step.agents.length) return [workflowStep(step, run)];

  const calls = [...step.agents].sort(byStart);

  if (step.stepId !== 'review-round' && !calls.some((call) => call.round !== null))
    return calls.map((call, index) => agentStep(call, index, step.stepId));

  const rounds = [...new Set(calls.map((call) => call.round ?? 1))].sort((a, b) => a - b);
  return rounds.flatMap((round) => {
    const inRound = calls.filter((call) => (call.round ?? 1) === round);
    return [
      roundNote(round, inRound, step.stepId),
      ...inRound.map((call) => agentStep(call, calls.indexOf(call), step.stepId)),
    ];
  });
};

const tasksOf = (run: RunDetail, itemCount: number): StepTask[] =>
  TASKS.map((task) => {
    const steps = run.steps.filter((step) => task.steps.includes(step.stepId));
    const statuses = steps.map((step) => stepStatusOf(step.status));
    const status: StepTask['status'] = !steps.length
      ? 'todo'
      : statuses.some((value) => value === 'failed' || value === 'waiting')
        ? 'blocked'
        : statuses.some((value) => value === 'running') || steps.length < task.steps.length
          ? LIVE_OUTCOMES.has(outcomeOf(run.status))
            ? 'active'
            : 'done'
          : 'done';
    return { id: task.id, title: task.title, status, addedAt: itemCount * 0 };
  });

const LIVE_OUTCOMES: ReadonlySet<StepOutcome> = new Set(['working', 'waiting']);

/** A run's trace as the step timeline draws it: workflow steps, agent hand-offs, review rounds, the approval wait. */
export const runActivityOf = (run: RunDetail): StepActivity => {
  const items = run.steps.flatMap((step) => rowsOfStep(step, run));
  const outcome = outcomeOf(run.status);
  const live = LIVE_OUTCOMES.has(outcome);
  return {
    outcome,
    startedAt: run.createdAt,
    answeredAt: null,
    endedAt: live ? null : run.updatedAt,
    items,
    tasks: tasksOf(run, items.length),
  };
};

/** "user:operator@demo.dev" → manual; cron and webhook triggers name themselves. */
export const triggerOf = (triggeredBy: string | null) => {
  if (!triggeredBy) return { kind: 'manual' as const, label: 'Manual', by: null };
  if (triggeredBy.startsWith('cron')) return { kind: 'cron' as const, label: 'Schedule', by: triggeredBy.replace(/^cron:?/, '') || null };
  if (triggeredBy.startsWith('webhook')) return { kind: 'webhook' as const, label: 'Webhook', by: triggeredBy.replace(/^webhook:?/, '') || null };
  if (triggeredBy.startsWith('agent:')) return { kind: 'copilot' as const, label: 'Copilot', by: triggeredBy.replace(/^agent:/, '') };
  return { kind: 'manual' as const, label: 'Manual', by: triggeredBy.replace(/^user:/, '') };
};
