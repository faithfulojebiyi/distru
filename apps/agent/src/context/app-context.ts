/**
 * The context layer (@ops/context) wired into the app:
 *
 * - **Store**: `DrizzleContextStore` over the app's Postgres (schema `context`, pushed by `db:push`).
 * - **Sync**: `createDistruSync` with a Distru client whose fetch is wrapped by the observer (reads
 *   `Date` + `X-RateLimit-*`). Runs on the Inngest cron `context-sync` (`CONTEXT_SYNC_CRON`, every 30
 *   min) → `sync.run()` then `buildProfile()`; Distru PRODUCT / PURCHASE / ORDER / COMPANY webhooks call
 *   `sync.handleWebhook` (deduped on type, id, occurred_datetime).
 * - **Memories**: harness decisions become learner signals after every decision
 *   (`ingestHarnessEvents(signalsFromAudit(...))`; approver edits compare against
 *   `proposal.meta.originalOps`), and policy edits (`policy.changed`) become `policy_rule_changed`.
 * - **Agents**: the `context` connector (read tools) is in the registry; the Planner and the Vendor
 *   Liaison get `context_context_for` plus a bounded context block in their prompts.
 */
import {
  buildProfile,
  createDistruObserver,
  createDistruSync,
  effectiveConfidence,
  ingestHarnessEvents,
  isLive,
  onboardingReport,
  signalsFromAudit,
  type ContextStore,
  type HarnessSignal,
  type IngestResult,
  type Memory,
} from '@ops/context';
import { DrizzleContextStore } from '@ops/context/drizzle';
import { createDistruClient } from '@ops/distru-client';
import { AuditEventSchema, type AuditEvent, type AuditSink, type Proposal } from '@ops/harness';
import { asc, eq, inArray } from 'drizzle-orm';
import { loadProposal } from '../harness/proposal-store';
import type { ContextProfile } from '../api/schemas-insight';
import type { DB } from '../db/client';
import { auditEvent } from '../db/schema';

export type AppContextSync = ReturnType<typeof createDistruSync>;

export function createAppContextSync(store: ContextStore, config: { baseUrl: string; token: string }) {
  const observer = createDistruObserver();
  const client = createDistruClient({ baseUrl: config.baseUrl, token: config.token, fetch: observer.wrap((url, init) => fetch(url, init)) });
  return createDistruSync({ client, store, observer });
}

export const createAppContextStore = (db: DB): ContextStore => new DrizzleContextStore(db);

/** One scheduled pass: incremental sync (all streams + inventory) then a fresh profile. */
export async function syncAndProfile(sync: AppContextSync, store: ContextStore, learn?: () => Promise<unknown>, opts: { mode?: 'auto' | 'reconcile' } = {}) {
  const run = await sync.run(opts.mode ? { mode: opts.mode } : {});
  const profile = await buildProfile(store);
  // Pick up decisions not learned yet (seeded history, or learning that failed at decision time).
  const learned = learn ? await learn().catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) })) : null;
  return {
    sync: { id: run.id, status: run.status, error: run.error, streams: Object.fromEntries(Object.entries(run.streams).map(([k, v]) => [k, { status: v?.status, fetched: v?.stats?.fetched ?? 0, deleted: v?.stats?.deleted ?? 0 }])), inventoryRows: run.inventory?.rows ?? null },
    profile: { version: profile.version, computedAt: profile.computedAt, counts: profile.counts },
    learned,
  };
}

// ── harness → memories ────────────────────────────────────────────────────────────────────────

/** The proposal's audit trail as harness events (rows that don't parse are skipped, never guessed). */
export async function auditEventsOf(db: DB, proposalId: string): Promise<AuditEvent[]> {
  const rows = await db.select().from(auditEvent).where(eq(auditEvent.proposalId, proposalId)).orderBy(asc(auditEvent.seq));
  return rows.flatMap((r) => {
    const parsed = AuditEventSchema.safeParse({ id: r.id, at: r.at.toISOString(), type: r.type, actor: r.actor, proposalId: r.proposalId, data: r.data });
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * After a decision: the proposal's decision / policy events become learner signals (idempotent: signals
 * are stored by audit id). `meta.originalOps` (set by the harness on edited approvals) is what the agent
 * proposed; `proposal.ops` is what was approved.
 */
export async function learnFromDecision(store: ContextStore, p: Proposal, events: readonly AuditEvent[]): Promise<IngestResult | null> {
  const signals = signalsFromAudit(events, { proposal: (id) => (id === p.id ? p : null) });
  if (!signals.length) return null;
  return ingestHarnessEvents(store, signals);
}

/**
 * Batch learning over every decided (or policy-denied) proposal, e.g. historical proposals created by
 * scripts/seed-history.ts (`meta.seed: 'history'`) or decisions made while learning was unavailable.
 * Signals are stored by audit id, so re-running only adds what is new; memories are recomputed once.
 */
export async function learnFromHistory(db: DB, store: ContextStore, opts: { limit?: number } = {}): Promise<{ proposals: number; signals: number; memories: number }> {
  const ids = (
    await db
      .selectDistinct({ id: auditEvent.proposalId })
      .from(auditEvent)
      .where(inArray(auditEvent.type, ['proposal.decided', 'policy.evaluated']))
      .limit(opts.limit ?? 5000)
  )
    .map((r) => r.id)
    .filter((id): id is string => typeof id === 'string');
  const signals: HarnessSignal[] = [];
  let proposals = 0;
  for (const id of ids) {
    const p = await loadProposal(db, id);
    if (!p) continue;
    const found = signalsFromAudit(await auditEventsOf(db, id), { proposal: (pid) => (pid === p.id ? p : null) });
    if (found.length) proposals++;
    signals.push(...found);
  }
  // Policy edits (no proposal) → policy_rule_changed.
  const policyRows = await db.select().from(auditEvent).where(eq(auditEvent.type, 'policy.changed')).orderBy(asc(auditEvent.seq)).limit(opts.limit ?? 5000);
  for (const r of policyRows) {
    const e = AuditEventSchema.safeParse({ id: r.id, at: r.at.toISOString(), type: r.type, actor: r.actor, proposalId: r.proposalId, data: r.data });
    const signal = e.success ? policySignalOf(e.data) : null;
    if (signal) signals.push(signal);
  }
  if (!signals.length) return { proposals, signals: 0, memories: 0 };
  const out = await ingestHarnessEvents(store, signals);
  return { proposals, signals: signals.length, memories: out.upserted.length };
}

const RecordOrNull = (v: unknown): Record<string, unknown> | null => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const view = v as { params?: unknown; enabled?: unknown };
  const params = typeof view.params === 'object' && view.params !== null && !Array.isArray(view.params) ? (view.params as Record<string, unknown>) : {};
  return { ...params, ...(typeof view.enabled === 'boolean' ? { enabled: view.enabled } : {}) };
};

/** `policy.changed` audit event → `policy_rule_changed` signal (params flattened, plus `enabled`). */
export function policySignalOf(e: AuditEvent): HarnessSignal | null {
  if (e.type !== 'policy.changed') return null;
  return {
    id: e.id,
    at: e.at,
    kind: 'policy_rule_changed',
    key: e.data.key,
    before: RecordOrNull(e.data.before),
    after: RecordOrNull(e.data.after),
    by: { kind: e.actor.kind, id: e.actor.id, ...(e.actor.label ? { label: e.actor.label } : {}) },
  };
}

/** An audit sink that also feeds policy edits to the memory learner (best-effort; the audit write wins). */
export function learningAuditSink(inner: AuditSink, store: () => ContextStore, onError: (err: unknown) => void = () => {}): AuditSink {
  return {
    append: async (event) => {
      await inner.append(event);
      const signal = policySignalOf(event);
      if (signal) await ingestHarnessEvents(store(), [signal]).catch(onError);
    },
  };
}

// ── read models for the API ───────────────────────────────────────────────────────────────────

export async function profileSummary(store: ContextStore): Promise<ContextProfile> {
  const [profile, cursors, runs] = await Promise.all([store.latestProfile(), store.listCursors(), store.listSyncRuns(1)]);
  const last = runs[0] ?? null;
  return {
    available: profile !== null,
    version: profile?.version ?? null,
    computedAt: profile?.computedAt ?? null,
    source: profile?.source ?? null,
    counts: profile?.counts ?? null,
    vendors: profile?.vendors ?? [],
    products: profile?.products ?? [],
    sync: {
      lastRunAt: last?.finishedAt ?? null,
      lastStatus: last?.status ?? null,
      cursors: cursors.map((c) => ({ stream: c.stream, cursorAt: c.cursorAt, lastFullAt: c.lastFullAt, lastRunAt: c.lastRunAt })),
    },
  };
}

export async function memoriesList(
  store: ContextStore,
  q: { scope?: Memory['scope'] | undefined; scopeId?: string | undefined; status?: Memory['status'] | undefined; limit: number },
  now = new Date(),
): Promise<Array<Memory & { effectiveConfidence: number }>> {
  const rows = await store.listMemories({ ...(q.scope ? { scope: q.scope } : {}), ...(q.scopeId ? { scopeIds: [q.scopeId] } : {}), ...(q.status ? { statuses: [q.status] } : {}) });
  return rows
    .map((m) => ({ ...m, effectiveConfidence: isLive(m, now) ? effectiveConfidence(m, now) : 0 }))
    .sort((a, b) => b.effectiveConfidence - a.effectiveConfidence || b.lastConfirmedAt.localeCompare(a.lastConfirmedAt))
    .slice(0, q.limit);
}

export const onboarding = (store: ContextStore) => onboardingReport(store);
