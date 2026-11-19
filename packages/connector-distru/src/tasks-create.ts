/**
 * `tasks.create` (registry name `distru.tasks.create`, tool `propose_distru_tasks_create`).
 *
 * Human hand-off: a Distru task (e.g. "Receive PO-1042 on 2026-12-03") assigned to a user and linked
 * to one record (a purchase here). Distru notifies the assignee. Risk `low`: an internal, trivially
 * reversible write (the task can be completed or deleted).
 *
 * `POST /tasks` without `id` creates. Distru has no idempotency header, so the harness key is stamped
 * into the description as `[ops-agent:idem=<key>]` and found again by listing tasks updated within
 * the free 30-day window.
 *
 * `purchase_id` (and the name) may contain op references such as `{{op:0.recordId}}` /
 * `{{op:0.purchase_number}}`: the harness resolves them from the PO op that ran before this one.
 */
import { DistruApiError, idempotencyMarker, IDEMPOTENCY_LOOKBACK_MS, type Task, type UpsertTaskBody } from '@ops/distru-client';
import { defineAction, InputValidationError, type CompensableOp, type CompensationPlan, type Mismatch, type OpResult } from '@ops/harness';
import { z } from 'zod';
import { label, must, type DistruCtx } from './shared';
import { stripIdempotencyMarkers } from './tools/orders';

const SingleLine = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((s) => !/[\r\n]/.test(s), 'must be a single line');

/** Default time of day for a date-only due date (end of the receiving day, UTC). */
const DEFAULT_DUE_TIME = 'T17:00:00Z';

export const TaskCreateInputSchema = z
  .object({
    name: SingleLine.describe('Task title shown to the assignee, e.g. "Receive PO-1042 on 2026-12-03"'),
    due: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).describe('Due date (YYYY-MM-DD → 17:00 UTC that day) or an ISO datetime'),
    description: z.string().trim().max(2000).optional().describe('Details for the assignee'),
    owner_id: z.string().min(1).optional().describe('Distru user id to assign'),
    owner_role: z.string().trim().min(1).max(100).optional().describe('Assign the first active user with this role name (case-insensitive), resolved via GET /users, e.g. "Purchasing Manager"'),
    purchase_id: z.string().min(1).max(200).optional().describe('Link the task to this purchase order (may be an op reference like {{op:0.recordId}})'),
    location_id: z.string().min(1).optional().describe("One of a company's locations (not your own) where the task happens"),
  })
  .refine((v) => !(v.owner_id && v.owner_role), { message: 'give owner_id or owner_role, not both', path: ['owner_role'] });
export type TaskCreateInput = z.infer<typeof TaskCreateInputSchema>;

/** The exact `POST /tasks` body (create only: no `id`). */
export const TaskCreatePayloadSchema = z.object({
  name: z.string().min(1),
  status: z.literal('ACTIVE'),
  due_datetime: z.string().min(1),
  description: z.string().nullable(),
  owner_id: z.string().nullable(),
  purchase_id: z.string().nullable(),
  location_id: z.string().nullable(),
});
export type TaskCreatePayload = z.infer<typeof TaskCreatePayloadSchema>;

/** A Distru task normalized to the request-body shape, so diff/verify are field-to-field. */
export interface TaskRecord {
  id: string;
  name: string;
  status: string;
  due_datetime: string;
  /** Without idempotency markers. */
  description: string | null;
  owner_id: string | null;
  owner_name: string | null;
  purchase_id: string | null;
  purchase_number: string | null;
  location_id: string | null;
}

const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function normalizeTask(t: Task): TaskRecord {
  return {
    id: t.id,
    name: t.name,
    status: t.status,
    due_datetime: t.due_datetime,
    description: stripIdempotencyMarkers(t.description),
    owner_id: t.owner?.id ?? null,
    owner_name: t.owner ? label(t.owner.full_name ?? t.owner.email) : null,
    purchase_id: strOrNull(t.purchase?.id),
    purchase_number: strOrNull(t.purchase?.purchase_number),
    location_id: t.location?.id ?? null,
  };
}

const dueDatetime = (due: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(due) ? `${due}${DEFAULT_DUE_TIME}` : new Date(due).toISOString());

const sameInstant = (a: string, b: string) => {
  const x = Date.parse(a);
  return Number.isFinite(x) && x === Date.parse(b);
};

/** First active (not deleted, not banned) user whose role name matches, case-insensitively. */
async function userByRole(ctx: DistruCtx, role: string): Promise<{ id: string; name: string } | null> {
  const client = ctx.connectors.distru;
  const users = await client.listAll(client.listUsers, {});
  const want = role.trim().toLowerCase();
  const hit = users.find((u) => !u.deleted_at && !u.banned && (u.role?.name ?? '').toLowerCase() === want);
  return hit ? { id: hit.id, name: label(hit.full_name ?? hit.email) } : null;
}

async function userName(ctx: DistruCtx, id: string): Promise<string> {
  try {
    const u = (await ctx.connectors.distru.getUser(id)).data;
    return u ? label(u.full_name ?? u.email) : id;
  } catch {
    return id;
  }
}

async function getTaskOrNull(ctx: DistruCtx, id: string): Promise<Task | null> {
  try {
    return (await ctx.connectors.distru.getTask(id)).data ?? null;
  } catch (err) {
    if (err instanceof DistruApiError && err.isNotFound) return null;
    throw err;
  }
}

export const tasksCreateAction = defineAction({
  name: 'tasks.create',
  resource: 'tasks',
  risk: 'low',
  requiredScope: 'propose',
  description:
    'Propose creating a Distru task assigned to a user (owner_id, or owner_role resolved via the users list) and linked to a purchase order, e.g. "Receive PO-1042 on 2026-12-03". The assignee is notified by Distru. Nothing is written until approved.',
  input: TaskCreateInputSchema,
  payload: TaskCreatePayloadSchema,

  loadBefore: async (): Promise<TaskRecord | null> => null,

  plan: async (ctx: DistruCtx, input): Promise<TaskCreatePayload> => {
    let owner = input.owner_id ?? null;
    if (input.owner_role) {
      const user = await userByRole(ctx, input.owner_role);
      if (!user) throw new InputValidationError(`No active Distru user with role "${input.owner_role}"`);
      owner = user.id;
    }
    return {
      name: input.name,
      status: 'ACTIVE',
      due_datetime: dueDatetime(input.due),
      description: input.description ?? null,
      owner_id: owner,
      purchase_id: input.purchase_id ?? null,
      location_id: input.location_id ?? null,
    };
  },

  execute: async (ctx: DistruCtx, payload, idempotencyKey) => {
    const marker = idempotencyMarker(idempotencyKey);
    const body: UpsertTaskBody = { ...payload, description: payload.description ? `${payload.description}\n${marker}` : marker };
    const task = must((await ctx.connectors.distru.upsertTask(body)).data, 'upsertTask');
    return { recordId: task.id, record: normalizeTask(task) };
  },

  findByIdempotencyKey: async (ctx: DistruCtx, idempotencyKey) => {
    const client = ctx.connectors.distru;
    const marker = idempotencyMarker(idempotencyKey);
    // A free list call: the updated_datetime lower bound stays inside Distru's 30-day window.
    const since = new Date(Date.now() - IDEMPOTENCY_LOOKBACK_MS).toISOString();
    for await (const t of client.paginate(client.listTasks, { updated_datetime: `${since},` })) {
      if (t.description?.includes(marker)) return { recordId: t.id, record: normalizeTask(t) };
    }
    return null;
  },

  verify: async (ctx: DistruCtx, recordId, expected) => {
    const task = await getTaskOrNull(ctx, recordId);
    if (!task) return { ok: false, mismatches: [{ path: [], expected: { name: expected.name }, actual: null }] };
    const t = normalizeTask(task);
    const mismatches: Mismatch[] = [];
    const check = (key: 'name' | 'status' | 'owner_id' | 'purchase_id' | 'location_id' | 'description', want: string | null) => {
      if (want !== t[key]) mismatches.push({ path: [key], expected: want, actual: t[key] });
    };
    check('name', expected.name);
    check('status', expected.status);
    check('description', expected.description);
    if (expected.owner_id !== null) check('owner_id', expected.owner_id);
    if (expected.purchase_id !== null) check('purchase_id', expected.purchase_id);
    if (expected.location_id !== null) check('location_id', expected.location_id);
    if (!sameInstant(expected.due_datetime, t.due_datetime)) mismatches.push({ path: ['due_datetime'], expected: expected.due_datetime, actual: t.due_datetime });
    return { ok: mismatches.length === 0, mismatches };
  },

  // A task moves no money: 0 toward value rules (own `undefined` valueOf so Object.prototype.valueOf is never used).
  valueOf: undefined,
  moneyless: true,

  outputs: (record) => ({ task_name: record.name, owner_id: record.owner_id }),

  // Undo: delete the task (DELETE /tasks/{id}; a 404 means it is already gone, e.g. deleted with its PO).
  planCompensation: planTaskCompensation,
  compensate: compensateTask,

  summarize: async (_input, payload, ctx: DistruCtx) => {
    const who = payload.owner_id ? await userName(ctx, payload.owner_id) : 'unassigned';
    return `Task "${payload.name}" → ${who}, due ${payload.due_datetime.slice(0, 10)}`;
  },
});

// ── Undo ─────────────────────────────────────────────────────────────────────────────────────

async function planTaskCompensation(ctx: DistruCtx, _op: CompensableOp, result: OpResult): Promise<CompensationPlan> {
  const id = result.recordId;
  if (!id) throw new InputValidationError('The task op recorded no task id');
  const task = await getTaskOrNull(ctx, id);
  if (!task) return { current: null, target: null, summary: `Task ${id} is already deleted`, value: 0 };
  const t = normalizeTask(task);
  return {
    current: { name: t.name, status: t.status, owner_name: t.owner_name, due_datetime: t.due_datetime, purchase_number: t.purchase_number },
    target: null,
    summary: `Delete task "${t.name}"${t.owner_name ? ` (assigned to ${t.owner_name})` : ''}`,
    value: 0,
  };
}

async function compensateTask(ctx: DistruCtx, _op: CompensableOp, result: OpResult) {
  const id = result.recordId;
  if (!id) throw new InputValidationError('The task op recorded no task id');
  try {
    await ctx.connectors.distru.deleteTask(id);
  } catch (err) {
    if (!(err instanceof DistruApiError && err.isNotFound)) throw err;
  }
  return { recordId: id, record: null };
}
