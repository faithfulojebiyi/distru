import { z } from 'zod';

import { hasSuspiciousText } from '../steps/step-activity-data';
import type { AgentStep, StepActivity } from '../steps/step-types';
import type { ToolRunView } from '../steps/tool-runs';

/** What a Copilot answer links to: the run it started, the proposal it created. */
export type CopilotLink =
  | { kind: 'run'; runId: string }
  | { kind: 'proposal'; proposalId: string; status: string | null };

/** One question and its answer, live or from the thread's history. */
export type CopilotTurn = {
  id: string;
  question: string;
  answer: string;
  activity: StepActivity;
  tools: ToolRunView[];
  links: CopilotLink[];
  status: 'streaming' | 'done' | 'failed' | 'stopped';
  error: CopilotError | null;
};

/**
 * Why a turn failed. `code` is the agent server's stable code (src/api/agent-errors.ts) or `network` when the
 * request never got an answer; `detail` is the raw technical message, shown only behind "Details".
 */
export const CopilotErrorCodeSchema = z.enum([
  'model_history_invalid',
  'rate_limited',
  'model_unavailable',
  'context_too_long',
  'agent_error',
  'network',
]);
export type CopilotErrorCode = z.infer<typeof CopilotErrorCodeSchema>;
export type CopilotError = { code: CopilotErrorCode; detail: string | null };

/** What the operator reads for each code. Never the provider's own message. */
export const COPILOT_ERROR_MESSAGES: Record<CopilotErrorCode, string> = {
  model_history_invalid: 'The Ops Lead hit a problem answering that. Try again.',
  rate_limited: 'The Ops Lead is busy right now. Wait a moment and try again.',
  model_unavailable: "The Ops Lead's model is unavailable right now. Try again in a minute.",
  context_too_long: 'This conversation is too long for the Ops Lead to read. Ask a shorter question.',
  agent_error: 'The Ops Lead hit a problem answering that. Try again.',
  network: 'Could not reach the Ops Agent server. Check your connection and try again.',
};

const ErrorLikeSchema = z.object({ name: z.string().optional(), message: z.string() }).passthrough();

/** The technical one-liner behind "Details": "AI_APICallError: messages.5…" (or the JSON when unknown). */
export const errorDetail = (error: unknown): string | null => {
  if (error === undefined || error === null) return null;
  if (typeof error === 'string') return error;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  const like = ErrorLikeSchema.safeParse(error);
  if (like.success) return like.data.name ? `${like.data.name}: ${like.data.message}` : like.data.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

/** A stream `error` chunk's payload → the turn's error (unknown or missing code → agent_error). */
export const copilotErrorOfChunk = (payload: unknown): CopilotError => {
  const parsed = z.object({ code: z.unknown().optional(), error: z.unknown().optional() }).passthrough().safeParse(payload);
  const code = CopilotErrorCodeSchema.safeParse(parsed.success ? parsed.data.code : undefined);
  return {
    code: code.success ? code.data : 'agent_error',
    detail: errorDetail(parsed.success && parsed.data.error !== undefined ? parsed.data.error : payload),
  };
};

/** A thrown request error (HTTP status in the client's message, or a network failure) → the turn's error. */
export const copilotErrorOfThrown = (error: unknown): CopilotError => {
  const detail = errorDetail(error);
  const status = /\bstatus:? (\d{3})\b/i.exec(detail ?? '')?.[1];
  if (status === '429') return { code: 'rate_limited', detail };
  if (status && Number(status) >= 500) return { code: 'model_unavailable', detail };
  if (error instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(detail ?? '')) return { code: 'network', detail };
  return { code: 'agent_error', detail };
};

/** The suggested first questions, shown while the thread is empty. */
export const SUGGESTED_PROMPTS = [
  'Which SKUs will stock out before their next PO arrives?',
  'What is retail sell-through telling us about Blue Dream?',
  'Which invoices are overdue? Sum by customer.',
  'Start a restock run for Los Angeles',
] as const;

/** "agent-inventoryAnalyst" → "Inventory Analyst"; "agent-procurement-planner" → "Procurement Planner". */
const agentNameOf = (toolName: string) => {
  const id = toolName.replace(/^agent[-_]/, '');
  const words = id
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .split(' ')
    .filter(Boolean);
  return words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(' ');
};

const isAgentTool = (toolName: string) => /^agent[-_]/.test(toolName);

/** "distru_velocity_report" → "distru.velocity_report", the name the connector catalogue uses. */
const toolTitle = (toolName: string) =>
  toolName.startsWith('distru_') ? `distru.${toolName.slice('distru_'.length)}` : toolName;

const connectorOf = (toolName: string) => {
  if (toolName.startsWith('distru_') || toolName.startsWith('propose_distru')) return { name: 'Distru', icon: 'database' };
  if (toolName.startsWith('headset_')) return { name: 'Headset', icon: 'chartBars' };
  if (toolName.startsWith('email_')) return { name: 'Email', icon: 'gmail' };
  return { name: 'Ops Agent', icon: 'tools' };
};

/** The question an agent hand-off carried, from the agent tool's arguments. */
const promptOf = (args: unknown) => {
  if (!args || typeof args !== 'object') return null;
  const record = args as Record<string, unknown>;
  for (const key of ['prompt', 'message', 'task', 'query', 'input']) {
    if (typeof record[key] === 'string') return record[key];
  }
  return null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A tool call's arguments as one short line for its step row ("location_id: 3f2a9c1e · lead_time_days: 14"), so
 * repeated calls of one tool read apart. Scalars only, ids shortened, at most 80 characters; null when empty.
 */
export const argsSummary = (args: unknown): string | null => {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const parts = Object.entries(args as Record<string, unknown>).flatMap(([key, value]) => {
    if (value === null || value === undefined || value === '') return [];
    if (typeof value === 'string') return [`${key}: ${UUID.test(value) ? value.slice(0, 8) : value}`];
    if (typeof value === 'number' || typeof value === 'boolean') return [`${key}: ${String(value)}`];
    if (Array.isArray(value) && value.every((item) => typeof item === 'string' || typeof item === 'number'))
      return value.length ? [`${key}: ${value.map((item) => (typeof item === 'string' && UUID.test(item) ? item.slice(0, 8) : item)).join(', ')}`] : [];
    return [];
  });
  if (!parts.length) return null;
  const line = parts.join(' · ');
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

const RunResultSchema =z.object({ runId: z.string() });
const ProposalResultSchema = z.object({ proposal_id: z.string(), status: z.string().optional() });

/** The links a tool's result carries: a started run, a created proposal. */
const linksOf = (result: unknown): CopilotLink[] => {
  const run = RunResultSchema.safeParse(result);
  if (run.success) return [{ kind: 'run', runId: run.data.runId }];
  const proposal = ProposalResultSchema.safeParse(result);
  if (proposal.success)
    return [{ kind: 'proposal', proposalId: proposal.data.proposal_id, status: proposal.data.status ?? null }];
  return [];
};

/** A subagent's result as text for its summary well. */
const summaryOf = (result: unknown) => {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && 'text' in result && typeof result.text === 'string') return result.text;
  return null;
};

export const emptyActivity = (startedAt: string): StepActivity => ({
  outcome: 'working',
  startedAt,
  answeredAt: null,
  endedAt: null,
  items: [],
  tasks: [],
});

export const newTurn = (id: string, question: string): CopilotTurn => ({
  id,
  question,
  answer: '',
  activity: emptyActivity(new Date().toISOString()),
  tools: [],
  links: [],
  status: 'streaming',
  error: null,
});

const replaceStep = (turn: CopilotTurn, id: string, change: (step: AgentStep) => AgentStep): CopilotTurn => ({
  ...turn,
  activity: {
    ...turn.activity,
    items: turn.activity.items.map((item) => (item.type === 'step' && item.id === id ? change(item) : item)),
  },
});

/** A tool call starts: a step row, and a card for a connector call. */
export const toolCalled = (
  turn: CopilotTurn,
  call: { toolCallId: string; toolName: string; args: unknown },
  at: string,
): CopilotTurn => {
  if (turn.activity.items.some((item) => item.id === call.toolCallId)) return turn;
  const agent = isAgentTool(call.toolName);
  const run = call.toolName === 'start_restock_run';
  const step: AgentStep = {
    type: 'step',
    id: call.toolCallId,
    kind: agent ? 'agent' : run ? 'run' : call.toolName.startsWith('propose_') ? 'propose' : 'tool',
    verb: agent ? 'Handed the question to' : run ? 'Started' : 'Called',
    object: agent
      ? { name: agentNameOf(call.toolName), agent: call.toolName }
      : { name: run ? 'a restock run' : toolTitle(call.toolName) },
    detail: agent ? promptOf(call.args) : argsSummary(call.args),
    status: 'running',
    startedAt: at,
    finishedAt: null,
    error: null,
    retryOf: null,
    note: null,
    input: agent ? undefined : call.args,
    tokens: null,
    costUsd: null,
    calls: [],
  };
  const connector = connectorOf(call.toolName);
  return {
    ...turn,
    activity: { ...turn.activity, items: [...turn.activity.items, step] },
    tools: agent
      ? turn.tools
      : [
          ...turn.tools,
          {
            id: call.toolCallId,
            toolName: call.toolName,
            title: toolTitle(call.toolName),
            connectionName: connector.name,
            icon: connector.icon,
            status: 'running',
            error: null,
            input: call.args,
          },
        ],
  };
};

/** A tool call ends: its row and card settle, a run or proposal it made becomes a link. */
export const toolFinished = (
  turn: CopilotTurn,
  done: { toolCallId: string; result: unknown; isError: boolean },
  at: string,
): CopilotTurn => {
  const suspicious = hasSuspiciousText(done.result);
  const error = done.isError ? (typeof done.result === 'string' ? done.result : 'The tool call failed.') : null;
  const next = replaceStep(turn, done.toolCallId, (step) => ({
    ...step,
    status: done.isError ? 'failed' : 'done',
    finishedAt: at,
    error,
    suspicious,
    note: step.kind === 'agent' ? summaryOf(done.result) : null,
    output: step.kind === 'agent' ? undefined : done.result,
    calls: step.calls.map((call) => (call.status === 'running' ? { ...call, status: 'done' } : call)),
  }));
  return {
    ...next,
    tools: next.tools.map((tool) =>
      tool.id === done.toolCallId
        ? { ...tool, status: done.isError ? 'failed' : 'succeeded', output: done.result, error, suspicious }
        : tool,
    ),
    links: [...next.links, ...linksOf(done.result)],
  };
};

/** A subagent's own tool calls, streamed through its parent's `tool-output`, join the hand-off's sub-card. */
export const subagentOutput = (turn: CopilotTurn, parentId: string, chunk: unknown): CopilotTurn => {
  const parsed = NestedChunkSchema.safeParse(chunk);
  if (!parsed.success) return turn;
  const { type, payload } = parsed.data;
  return replaceStep(turn, parentId, (step) => {
    if (type === 'tool-call' && !step.calls.some((call) => call.id === payload.toolCallId))
      return {
        ...step,
        calls: [
          ...step.calls,
          { id: payload.toolCallId, tool: payload.toolName ?? 'tool', status: 'running', durationMs: null, error: null, input: payload.args },
        ],
      };
    if (type === 'tool-result')
      return {
        ...step,
        calls: step.calls.map((call) =>
          call.id === payload.toolCallId
            ? {
                ...call,
                status: payload.isError ? 'failed' : 'done',
                output: payload.result,
                suspicious: hasSuspiciousText(payload.result),
              }
            : call,
        ),
      };
    return step;
  });
};

const NestedChunkSchema = z.object({
  type: z.enum(['tool-call', 'tool-result']),
  payload: z.object({
    toolCallId: z.string(),
    toolName: z.string().optional(),
    args: z.unknown().optional(),
    result: z.unknown().optional(),
    isError: z.boolean().optional(),
  }),
});

/** The turn ends: running rows stop, and the timeline records when. */
export const turnEnded = (
  turn: CopilotTurn,
  status: CopilotTurn['status'],
  at: string,
  error: CopilotError | null = null,
): CopilotTurn => ({
  ...turn,
  status,
  error,
  activity: {
    ...turn.activity,
    outcome: status === 'done' ? 'answered' : status === 'failed' ? 'failed' : 'stopped',
    endedAt: at,
    answeredAt: turn.activity.answeredAt ?? at,
    items: turn.activity.items.map((item) =>
      item.type === 'step' && item.status === 'running'
        ? { ...item, status: status === 'done' ? 'done' : 'stopped', finishedAt: item.finishedAt ?? at }
        : item,
    ),
  },
  tools: turn.tools.map((tool) =>
    tool.status === 'running' ? { ...tool, status: status === 'done' ? 'succeeded' : 'failed' } : tool,
  ),
});

/** The answer's first words: the timeline folds and counts its time up to here. */
export const textArrived = (turn: CopilotTurn, text: string, at: string): CopilotTurn => ({
  ...turn,
  answer: turn.answer + text,
  activity: turn.activity.answeredAt ? turn.activity : { ...turn.activity, answeredAt: at },
});

// ── stored history ────────────────────────────────────────────────────────────────────────────

const StoredPartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool-invocation'),
    toolInvocation: z.object({
      toolCallId: z.string().optional(),
      toolName: z.string(),
      args: z.unknown().optional(),
      result: z.unknown().optional(),
      state: z.string().optional(),
    }),
  }),
  z.object({ type: z.string() }).passthrough(),
]);

const StoredMessageSchema = z.object({
  id: z.string(),
  role: z.string(),
  createdAt: z.union([z.string(), z.date()]).optional(),
  content: z.union([
    z.string(),
    z.object({ parts: z.array(StoredPartSchema).optional(), content: z.string().optional() }).passthrough(),
  ]),
});

const textOfContent = (content: z.infer<typeof StoredMessageSchema>['content']) => {
  if (typeof content === 'string') return content;
  const parts = content.parts ?? [];
  const texts = parts.flatMap((part) => ('text' in part && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []));
  return texts.length ? texts.join('\n\n') : (content.content ?? '');
};

/** The thread as turns: each user message opens one, the assistant messages after it fill it. */
export const turnsOfHistory = (messages: readonly unknown[]): CopilotTurn[] => {
  const turns: CopilotTurn[] = [];
  for (const raw of messages) {
    const parsed = StoredMessageSchema.safeParse(raw);
    if (!parsed.success) continue;
    const message = parsed.data;
    const at = message.createdAt ? new Date(message.createdAt).toISOString() : new Date(0).toISOString();
    if (message.role === 'user') {
      turns.push({ ...newTurn(message.id, textOfContent(message.content)), activity: emptyActivity(at), status: 'done' });
      continue;
    }
    let turn = turns.at(-1);
    if (!turn || message.role !== 'assistant') continue;
    const parts = typeof message.content === 'string' ? [] : (message.content.parts ?? []);
    parts.forEach((part, index) => {
      if (!turn) return;
      if (part.type === 'tool-invocation' && 'toolInvocation' in part) {
        const call = part.toolInvocation as { toolCallId?: string; toolName: string; args?: unknown; result?: unknown };
        const id = call.toolCallId ?? `${message.id}:${index}`;
        // History has no step times, so stored rows show no duration.
        turn = toolCalled(turn, { toolCallId: id, toolName: call.toolName, args: call.args ?? {} }, turn.activity.startedAt);
        turn = toolFinished(turn, { toolCallId: id, result: call.result, isError: false }, '');
      } else if (part.type === 'text' && 'text' in part && typeof part.text === 'string') {
        turn = { ...turn, answer: turn.answer ? `${turn.answer}\n\n${part.text}` : part.text };
      } else if (part.type === 'error') {
        // A failed turn is stored with the provider's error: show it as failed, in our words.
        turn = { ...turn, status: 'failed', error: copilotErrorOfChunk(part) };
      }
    });
    if (typeof message.content === 'string') turn = { ...turn, answer: message.content };
    turn = {
      ...turn,
      activity: { ...turn.activity, outcome: turn.status === 'failed' ? 'failed' : 'answered', endedAt: at, answeredAt: at },
    };
    turns[turns.length - 1] = turn;
  }
  return turns;
};
