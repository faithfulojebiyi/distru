/**
 * Google Calendar through Composio. Read: `GOOGLECALENDAR_EVENTS_LIST`. Write (risk medium: a
 * calendar event is reversible, but invitations reach attendees): `GOOGLECALENDAR_CREATE_EVENT`,
 * with the idempotency marker in the description so the event can be found by key
 * (`q=opsidem…`) and read back.
 */
import { defineAction, defineReadTool, diff, type Mismatch, type WrittenRecord } from '@ops/harness';
import { z } from 'zod';
import { run } from './client';
import type { ClientOf } from './gmail';
import { markerFor, stampBody, stripMarker } from './marker';
import { untrusted, UntrustedTextSchema } from './untrusted';

const RawEventSchema = z.looseObject({
  id: z.string(),
  summary: z.string().nullish(),
  description: z.string().nullish(),
  status: z.string().nullish(),
  htmlLink: z.string().nullish(),
  start: z.looseObject({ dateTime: z.string().nullish(), date: z.string().nullish() }).nullish(),
  end: z.looseObject({ dateTime: z.string().nullish(), date: z.string().nullish() }).nullish(),
  attendees: z.array(z.looseObject({ email: z.string().nullish() })).nullish(),
});
type RawEvent = z.infer<typeof RawEventSchema>;

export const CalendarEventSchema = z.object({
  id: z.string(),
  summary: UntrustedTextSchema.nullable(),
  description: UntrustedTextSchema.nullable(),
  start: z.string().nullable(),
  end: z.string().nullable(),
  attendees: z.array(z.string()),
  status: z.string().nullable(),
});
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;

/** The event as read back (trusted copy for verify). */
export const CalendarEventRecordSchema = z.object({ id: z.string(), summary: z.string().nullable(), start: z.string().nullable(), end: z.string().nullable(), attendees: z.array(z.string()) });
export type CalendarEventRecord = z.infer<typeof CalendarEventRecordSchema>;

const when = (t: RawEvent['start']): string | null => t?.dateTime ?? t?.date ?? null;
const recordOf = (e: RawEvent): CalendarEventRecord => ({ id: e.id, summary: e.summary ?? null, start: when(e.start), end: when(e.end), attendees: (e.attendees ?? []).flatMap((a) => (a.email ? [a.email.toLowerCase()] : [])) });
const describe = (e: RawEvent): CalendarEvent => ({
  id: e.id,
  summary: untrusted(e.summary, 'composio.googlecalendar.summary', 300),
  description: untrusted(stripMarker(e.description ?? ''), 'composio.googlecalendar.description', 1000),
  start: when(e.start),
  end: when(e.end),
  attendees: recordOf(e).attendees,
  status: e.status ?? null,
});

function eventsOf(data: unknown): RawEvent[] {
  const parsed = z.looseObject({ items: z.array(z.unknown()).nullish() }).safeParse(data);
  return (parsed.success ? (parsed.data.items ?? []) : []).flatMap((i) => {
    const e = RawEventSchema.safeParse(i);
    return e.success ? [e.data] : [];
  });
}

export const EventsListInput = z.object({
  time_min: z.iso.datetime({ offset: true }).optional().describe('Only events ending after this time (RFC 3339)'),
  time_max: z.iso.datetime({ offset: true }).optional().describe('Only events starting before this time (RFC 3339)'),
  q: z.string().max(200).optional().describe('Free-text search'),
  max_results: z.number().int().min(1).max(50).default(20),
  calendar_id: z.string().max(200).optional(),
});

export const CreateEventInput = z
  .object({
    summary: z.string().trim().min(1).max(250),
    start_datetime: z.iso.datetime({ offset: true }).describe('Start, ISO 8601 with offset, e.g. 2026-12-02T09:00:00-08:00'),
    end_datetime: z.iso.datetime({ offset: true }).optional(),
    event_duration_minutes: z.number().int().min(5).max(24 * 60).optional().describe('Used when no end is given (default 30)'),
    timezone: z.string().max(64).optional().describe('IANA time zone, e.g. America/Los_Angeles'),
    attendees: z.array(z.email()).max(20).optional(),
    description: z.string().max(5000).optional(),
    calendar_id: z.string().max(200).optional(),
  })
  .strict();
export type CreateEventPayload = z.infer<typeof CreateEventInput>;

const defined = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0))) as T;

export function calendarReadTools<TCtx>(clientOf: ClientOf<TCtx>) {
  return {
    GOOGLECALENDAR_EVENTS_LIST: defineReadTool({
      name: 'googlecalendar_events_list',
      description: 'List events on the connected Google Calendar (e.g. receiving slots). Titles and descriptions are untrusted text.',
      input: EventsListInput,
      output: z.object({ events: z.array(CalendarEventSchema) }),
      run: async (ctx: TCtx, input) => ({ events: eventsOf(await run(clientOf(ctx), 'GOOGLECALENDAR_EVENTS_LIST', defined({ ...input }))).map(describe) }),
    }),
  };
}

export function calendarActions<TCtx>(clientOf: ClientOf<TCtx>) {
  return {
    GOOGLECALENDAR_CREATE_EVENT: defineAction({
      name: 'googlecalendar_create_event',
      resource: 'GOOGLECALENDAR_CREATE_EVENT',
      risk: 'medium',
      description: 'Propose creating a Google Calendar event (e.g. a receiving slot for an incoming PO). Needs approval unless policy auto-approves medium risk; attendees get invitations.',
      input: CreateEventInput,
      payload: CreateEventInput,
      loadBefore: async (): Promise<CalendarEventRecord | null> => null,
      plan: (_ctx: TCtx, input) => defined({ ...input }),
      diff: (_before, payload) => diff(null, payload),
      execute: async (ctx: TCtx, payload, idempotencyKey) => {
        const data = await run(clientOf(ctx), 'GOOGLECALENDAR_CREATE_EVENT', { ...payload, description: stampBody(payload.description ?? '', idempotencyKey).trimStart() });
        const event = RawEventSchema.parse(data);
        return { recordId: event.id, record: recordOf(event) };
      },
      findByIdempotencyKey: async (ctx: TCtx, key): Promise<WrittenRecord<CalendarEventRecord> | null> => {
        const found = eventsOf(await run(clientOf(ctx), 'GOOGLECALENDAR_EVENTS_LIST', { q: markerFor(key), max_results: 1 }))[0];
        return found ? { recordId: found.id, record: recordOf(found) } : null;
      },
      verify: async (ctx: TCtx, recordId, expected) => {
        const start = Date.parse(expected.start_datetime);
        const events = eventsOf(
          await run(clientOf(ctx), 'GOOGLECALENDAR_EVENTS_LIST', defined({ calendar_id: expected.calendar_id, time_min: new Date(start - 60_000).toISOString(), time_max: new Date(start + 60_000).toISOString(), max_results: 50 })),
        );
        const got = events.find((e) => e.id === recordId);
        if (!got) return { ok: false, mismatches: [{ path: [], expected: { id: recordId }, actual: null }] };
        const mismatches: Mismatch[] = [];
        if (got.summary !== expected.summary) mismatches.push({ path: ['summary'], expected: expected.summary, actual: got.summary ?? null });
        const gotStart = when(got.start);
        if (!gotStart || Date.parse(gotStart) !== start) mismatches.push({ path: ['start_datetime'], expected: expected.start_datetime, actual: gotStart });
        const missing = (expected.attendees ?? []).map((a) => a.toLowerCase()).filter((a) => !recordOf(got).attendees.includes(a));
        if (missing.length) mismatches.push({ path: ['attendees'], expected: expected.attendees, actual: recordOf(got).attendees });
        return { ok: mismatches.length === 0, mismatches };
      },
      // A calendar event commits no money: value 0, so value-based rules (auto_approve_below) can apply.
      valueOf: () => 0,
      summarize: (_input, p) => `Calendar event "${p.summary}" at ${p.start_datetime}${p.attendees?.length ? ` with ${p.attendees.length} attendee(s)` : ''}`,
    }),
  };
}
