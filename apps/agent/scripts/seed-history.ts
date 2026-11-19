/**
 * Decision history for the demo: ~12 proposals over the past 8 weeks, made with the real harness
 * (diffs, policy, approver edits → `meta.originalOps`, audit events) on a backdated clock, then stored
 * through the app's Drizzle adapters. Nothing is written to Distru: approved proposals are *marked*
 * executed (op results + `proposal.execution_started` / `op.executed` / `op.verified` /
 * `proposal.executed` audit events); reads for planning go to an in-process copy of the mock, whose
 * ids are the dev mock's (the seed is deterministic).
 *
 * The story it tells:
 * - Mojave Pre-Roll Co.: 5 restock POs; the approver trims quantities ~20% on 4 of them and moves the
 *   delivery date on the 5th.
 * - Golden State Edibles: a holiday-prep PO is denied by the $15,000 cap → the approver raises the cap
 *   to $25,000 (`policy.changed`) → the same PO is re-proposed and approved.
 * - Emerald Triangle Growers: a Wedding Cake restock is vetoed by compliance (failed pesticide panel),
 *   then a later PO is rejected: "vendor on hold pending lab results".
 * - Humboldt, Sierra, Coastal Cloud: approved as proposed.
 *
 * Every proposal has `meta.seed = 'history'`; ids are deterministic. Re-running is a no-op; `--reset`
 * removes the seeded proposals (+ their ops, approvals and audit events, and the seeded policy change)
 * and creates them again with dates relative to now. `--dry-run` uses in-memory stores (no database).
 * Either way it ends by printing what @ops/context would learn (signalsFromAudit → ingestHarnessEvents
 * into an in-memory context store); wiring that into the app's context store is `learnFromHistory`.
 *
 *   bun scripts/seed-history.ts [--reset] [--dry-run]
 */
import { createHash } from 'node:crypto';
import {
  ingestHarnessEvents,
  InMemoryContextStore,
  normalizeCompany,
  normalizeProduct,
  signalsFromAudit,
  type HarnessSignal,
  type Memory,
} from '@ops/context';
import { createDistruContext, distruConnector, type DistruCtx } from '@ops/connector-distru';
import { createMockServer } from '@ops/distru-mock';
import {
  agentPrincipal,
  AuditEventSchema,
  createHarness,
  EXECUTOR_ACTOR,
  InMemoryAuditSink,
  InMemoryProposalStore,
  ProposalSchema,
  Registry,
  userPrincipal,
  type AuditEvent,
  type AuditEventInput,
  type AuditSink,
  type Clock,
  type PolicyRuleConfig,
  type Principal,
  type Proposal,
  type ProposalStore,
} from '@ops/harness';
import { policySignalOf } from '../src/context/app-context';
import { DEFAULT_POLICY } from '../src/db/seed-policy';
import { appPolicyEngine } from '../src/harness/policy';

const args = new Set(process.argv.slice(2));
const RESET = args.has('--reset');
const DRY_RUN = args.has('--dry-run');
const SEED_TAG = 'history';
const DAY = 86_400_000;
const HOUR = 3_600_000;

// ── deterministic ids, backdated clock ───────────────────────────────────────────────────────

/** UUID-shaped ids from a counter, so `--reset` recreates the same rows. */
function deterministicIds(ns: string) {
  let n = 0;
  return () => {
    const h = createHash('sha256').update(`${ns}:${++n}`).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
  };
}

/** A clock the script moves: every harness timestamp is "then", not now. */
class BackdatedClock implements Clock {
  t = 0;
  now(): Date {
    return new Date(this.t);
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
}

const NOW = Date.now();
/** `days` ago at `hour`:`minute` UTC (the demo company is in California: 16:00 UTC ≈ 8–9 am). */
const at = (days: number, hour: number, minute = 0) => Math.floor((NOW - days * DAY) / DAY) * DAY + hour * HOUR + minute * 60_000;

// ── the world (in-process mock: same ids as the dev mock) ────────────────────────────────────

const mock = createMockServer({ now: new Date(NOW).toISOString() });
const world = mock.store;
const vendor = (name: string) => [...world.companies.values()].find((c) => c.name === name)!;
const product = (sku: string) => [...world.products.values()].find((p) => p.sku === sku)!;
const OAKLAND = world.ownLocationIds[0]!;
/** The vendor's latest unit price for a product (its most recent PO line), else the catalog cost. */
function lastPrice(sku: string): number {
  const p = product(sku);
  const latest = [...world.purchases.values()]
    .filter((po) => po.status === 'COMPLETED' && po.order_datetime)
    .sort((a, b) => (a.order_datetime! < b.order_datetime! ? 1 : -1))
    .flatMap((po) => po.items)
    .find((i) => (i.product_id ?? (i.batch_id ? world.batches.get(i.batch_id)?.product_id : null)) === p.id);
  return latest?.price ?? p.unit_cost;
}
const ctx: DistruCtx = createDistruContext({ baseUrl: 'http://mock.local', token: 'mock-token', fetch: async (url, init) => mock.app.request(url, init) });

// ── policy as it was: the cap was $15,000 until the revision ─────────────────────────────────

const CAP_BEFORE = 15_000;
const CAP_AFTER = 25_000;
const policyAt = (cap: number): PolicyRuleConfig[] =>
  DEFAULT_POLICY.map(({ description: _d, ...rule }) => (rule.key === 'max_total_value' ? { ...rule, params: { ...rule.params, max: cap } } : rule));
const policy = { rules: policyAt(CAP_BEFORE), list: async () => policy.rules };

// ── the script of events ─────────────────────────────────────────────────────────────────────

type Line = [sku: string, qty: number];
interface Step {
  days: number;
  hour: number;
  vendor: string;
  lines: Line[];
  title: string;
  rationale: string;
  delivery?: string;
  /** hours from proposal to decision */
  lag?: number;
  decision:
    | { kind: 'approve' }
    | { kind: 'approve_edited'; reason: string; lines?: Line[]; delivery?: string }
    | { kind: 'reject'; by: 'approver' | 'compliance'; reason: string }
    | { kind: 'denied' };
  /** raise the cap right after this step */
  thenRaiseCap?: { days: number; hour: number };
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const deliveryIn = (days: number, lead: number) => isoDate(at(days - lead, 12));

const MPR = 'Mojave Pre-Roll Co.';
const GSE_HOLIDAY: Line[] = [
  ['EDB-GUM-WM', 1056],
  ['EDB-GUM-SB', 576],
  ['EDB-CHO-DK', 360],
  ['EDB-BEV-LEM', 720],
  ['EDB-GUM-SLP', 240],
];

const STEPS: Step[] = [
  {
    days: 54, hour: 16, vendor: MPR, lag: 3,
    lines: [['PRE-BD-1G', 600], ['PRE-OGK-1G', 300], ['PRE-INF-1G', 200]],
    title: 'Restock Mojave pre-rolls (3 SKUs)', rationale: 'PRE-BD-1G and PRE-OGK-1G are below their reorder points at Oakland; ~30 days of supply at current velocity.',
    decision: { kind: 'approve_edited', reason: 'Trim ~20% — still sitting on pre-rolls from the last drop.', lines: [['PRE-BD-1G', 480], ['PRE-OGK-1G', 240], ['PRE-INF-1G', 160]] },
  },
  {
    days: 50, hour: 17, vendor: 'Humboldt Heritage Farms', lag: 2,
    lines: [['FLW-BD-35', 288], ['FLW-OGK-35', 192], ['FLW-GSC-35', 144]],
    title: 'Restock Humboldt flower eighths', rationale: 'Blue Dream 3.5g is trending up (+35% over 30 days); OG Kush is at its alert minimum.',
    decision: { kind: 'approve' },
  },
  {
    days: 46, hour: 16, vendor: MPR, lag: 5,
    lines: [['PRE-BD-1G', 550], ['PRE-JH-1G', 250], ['PRE-GDP-1G', 250]],
    title: 'Restock Mojave pre-rolls (3 SKUs)', rationale: 'Blue Dream pre-rolls below reorder point at all three locations.',
    decision: { kind: 'approve_edited', reason: 'Cut back ~20%, Mojave orders keep running heavy.', lines: [['PRE-BD-1G', 450], ['PRE-JH-1G', 200], ['PRE-GDP-1G', 200]] },
  },
  {
    days: 43, hour: 18, vendor: 'Sierra Extracts Co.', lag: 4,
    lines: [['VAP-BD-1G', 300], ['CON-LR-BD', 200], ['VAP-NL-1G', 150]],
    title: 'Restock Sierra live resin (3 SKUs)', rationale: 'Blue Dream live resin carts and sauce are below reorder point; 14-day lead time.',
    decision: { kind: 'approve' },
  },
  {
    days: 40, hour: 16, vendor: 'Golden State Edibles', lag: 0,
    lines: GSE_HOLIDAY,
    title: 'Holiday stock-up: Golden State edibles', rationale: 'Edibles demand rose ~25% in December last year; 21-day lead time means ordering now.',
    decision: { kind: 'denied' },
    thenRaiseCap: { days: 39, hour: 17 },
  },
  {
    days: 39, hour: 18, vendor: 'Golden State Edibles', lag: 1,
    lines: GSE_HOLIDAY,
    title: 'Holiday stock-up: Golden State edibles', rationale: 'Re-proposed after the PO cap was raised to $25,000 for holiday volume.',
    decision: { kind: 'approve' },
  },
  {
    days: 35, hour: 16, vendor: MPR, lag: 2,
    lines: [['PRE-BD-1G', 650], ['PRE-SD-5PK', 160], ['PRE-INF-1G', 200]],
    title: 'Restock Mojave pre-rolls (3 SKUs)', rationale: 'Pre-roll velocity up ahead of the holidays.',
    decision: { kind: 'approve_edited', reason: 'Too many units again — trim ~20%.', lines: [['PRE-BD-1G', 520], ['PRE-SD-5PK', 120], ['PRE-INF-1G', 160]] },
  },
  {
    days: 24, hour: 17, vendor: MPR, lag: 4,
    lines: [['PRE-BD-1G', 700], ['PRE-OGK-1G', 300]],
    title: 'Restock Mojave pre-rolls (2 SKUs)', rationale: 'PRE-BD-1G at 6 days of supply.',
    decision: { kind: 'approve_edited', reason: 'Smaller order, ~20% fewer units; we can top up next week.', lines: [['PRE-BD-1G', 560], ['PRE-OGK-1G', 240]] },
  },
  {
    days: 20, hour: 16, vendor: 'Emerald Triangle Growers', lag: 6,
    lines: [['FLW-WC-35', 288]],
    title: 'Restock Wedding Cake 3.5g', rationale: 'Wedding Cake 3.5g is below its reorder point company-wide (8 days of supply).',
    decision: { kind: 'reject', by: 'compliance', reason: 'Compliance veto: newest Wedding Cake 3.5g batch failed its lab test (pesticides — myclobutanil 0.92 µg/g, action level 0.10). Packages are on hold in Metrc; no reorder until a passing COA.' },
  },
  {
    days: 17, hour: 17, vendor: 'Coastal Cloud Vapes', lag: 3,
    lines: [['VAP-PE-1G', 250], ['VAP-GSC-05', 200], ['VAP-WM-1G', 150]],
    title: 'Restock Coastal Cloud carts (3 SKUs)', rationale: 'Pineapple Express carts below reorder point; priced at the new (+7%) price sheet.',
    decision: { kind: 'approve' },
  },
  {
    days: 13, hour: 16, vendor: 'Emerald Triangle Growers', lag: 2,
    lines: [['FLW-SD-35', 192], ['FLW-GG4-35', 144], ['FLW-ZK-35', 96]],
    title: 'Restock Emerald Triangle flower (3 SKUs)', rationale: 'Sour Diesel and GG4 eighths are under 20 days of supply.',
    decision: { kind: 'reject', by: 'approver', reason: 'Vendor on hold pending lab results — waiting on the Wedding Cake retest COA before any new Emerald Triangle orders.' },
  },
  {
    days: 9, hour: 16, vendor: MPR, lag: 3,
    lines: [['PRE-BD-1G', 600], ['PRE-JH-1G', 200]],
    title: 'Restock Mojave pre-rolls (2 SKUs)', rationale: 'PRE-BD-1G below reorder point at Oakland and LA.',
    delivery: '__auto__',
    decision: { kind: 'approve_edited', reason: 'Move delivery to Tuesday — Mojave only delivers Tuesdays.', delivery: '__tuesday__' },
  },
];

// ── run ──────────────────────────────────────────────────────────────────────────────────────

interface Stores {
  store: ProposalStore;
  audit: AuditSink;
  approver: Principal;
  done: () => Promise<void>;
  existing: () => Promise<number>;
  remove: () => Promise<number>;
  load: () => Promise<{ proposals: Proposal[]; events: AuditEvent[] }>;
}

const COMPLIANCE = userPrincipal('compliance-casey', 'approver', 'Casey Ng (Compliance)');
const PLANNER = agentPrincipal('procurement-planner', 'Procurement Planner');

async function memoryStores(): Promise<Stores> {
  const store = new InMemoryProposalStore();
  const audit = new InMemoryAuditSink();
  const ids = new Set<string>();
  const tracked: ProposalStore = {
    create: async (p) => {
      ids.add(p.id);
      await store.create(p);
    },
    get: (id) => store.get(id),
    compareAndSet: (next, v) => store.compareAndSet(next, v),
  };
  return {
    store: tracked,
    audit,
    approver: userPrincipal('u-approver', 'approver', 'Adam Approver'),
    done: async () => {},
    existing: async () => 0,
    remove: async () => 0,
    load: async () => ({ proposals: (await Promise.all([...ids].map((id) => store.get(id)))).filter((p): p is Proposal => !!p), events: audit.events }),
  };
}

async function databaseStores(): Promise<Stores> {
  // imported lazily: these read the app's env (DATABASE_URL, BETTER_AUTH_SECRET) and open a pool
  const { db, sql } = await import('../src/db/client');
  const schema = await import('../src/db/schema');
  const { DrizzleProposalStore, loadProposal } = await import('../src/harness/proposal-store');
  const { DrizzleAuditSink } = await import('../src/harness/audit-sink');
  const { auditEventsOf } = await import('../src/context/app-context');
  const { eq, inArray, or, sql: q } = await import('drizzle-orm');

  const [adam] = await db.select().from(schema.user).where(eq(schema.user.email, 'approver@demo.dev'));
  if (!adam) throw new Error('approver@demo.dev not found: run `bun run --cwd apps/agent db:seed` first');
  const seededIds = async () => (await db.select({ id: schema.proposal.id }).from(schema.proposal).where(q`${schema.proposal.meta}->>'seed' = ${SEED_TAG}`)).map((r) => r.id);
  return {
    store: new DrizzleProposalStore(db),
    audit: new DrizzleAuditSink(db),
    approver: userPrincipal(adam.id, 'approver', adam.name),
    done: async () => {
      await sql.end();
    },
    existing: async () => (await seededIds()).length,
    remove: async () => {
      const ids = await seededIds();
      await db.transaction(async (tx) => {
        const cond = ids.length ? or(inArray(schema.auditEvent.proposalId, ids), eq(schema.auditEvent.id, POLICY_EVENT_ID)) : eq(schema.auditEvent.id, POLICY_EVENT_ID);
        await tx.delete(schema.auditEvent).where(cond);
        if (ids.length) {
          await tx.delete(schema.slackMessage).where(inArray(schema.slackMessage.proposalId, ids));
          await tx.delete(schema.proposal).where(inArray(schema.proposal.id, ids)); // ops, approvals, pending executions cascade
        }
      });
      return ids.length;
    },
    load: async () => {
      const ids = await seededIds();
      const proposals = (await Promise.all(ids.map((id) => loadProposal(db, id)))).filter((p): p is Proposal => !!p);
      const events = (await Promise.all(ids.map((id) => auditEventsOf(db, id)))).flat();
      const [policyRow] = await db.select().from(schema.auditEvent).where(eq(schema.auditEvent.id, POLICY_EVENT_ID));
      if (policyRow) {
        const parsed = AuditEventSchema.safeParse({ id: policyRow.id, at: policyRow.at.toISOString(), type: policyRow.type, actor: policyRow.actor, proposalId: policyRow.proposalId, data: policyRow.data });
        if (parsed.success) events.push(parsed.data);
      }
      return { proposals, events };
    },
  };
}

const ids = deterministicIds('ops-seed-history');
/** The seeded `policy.changed` event has a fixed id of its own (it has no proposal to find it by). */
const POLICY_EVENT_ID = deterministicIds('ops-seed-history-policy')();

async function seed(s: Stores): Promise<void> {
  const clock = new BackdatedClock();
  const harness = createHarness<DistruCtx>({
    registry: Registry.fromConnectors([distruConnector]),
    store: s.store,
    audit: s.audit,
    policyRules: policy,
    policyEngine: appPolicyEngine,
    clock,
    ids,
  });

  const input = (step: Step, lines: Line[], delivery?: string) => ({
    vendor_id: vendor(step.vendor).id,
    location_id: OAKLAND,
    lines: lines.map(([sku, quantity]) => ({ product_id: product(sku).id, quantity, unit_price: lastPrice(sku) })),
    ...(delivery ? { expected_delivery_date: delivery } : {}),
    notes: step.title,
  });

  for (const step of STEPS) {
    clock.t = at(step.days, step.hour, 7);
    const lead = vendor(step.vendor).lead_time_days;
    const delivery = deliveryIn(step.days, lead);
    const p = await harness.propose({
      ctx,
      principal: PLANNER,
      title: step.title,
      rationale: step.rationale,
      ops: [{ action: 'distru.purchases.upsert', input: input(step, step.lines, step.delivery ? delivery : undefined) }],
      meta: { seed: SEED_TAG, source: 'scripts/seed-history.ts' },
    });
    const d = step.decision;
    if (d.kind === 'denied') {
      if (p.status !== 'denied') throw new Error(`expected the cap to deny "${step.title}" (${p.ops[0]!.value}), got ${p.status}`);
    } else {
      if (p.status !== 'pending_approval') throw new Error(`"${step.title}": expected pending_approval, got ${p.status}`);
      clock.t += (step.lag ?? 2) * HOUR + 13 * 60_000;
      if (d.kind === 'reject') {
        await harness.decide({ ctx, principal: d.by === 'compliance' ? COMPLIANCE : s.approver, proposalId: p.id, decision: 'reject', reason: d.reason });
      } else {
        const edits =
          d.kind === 'approve_edited'
            ? [
                {
                  opIndex: 0,
                  input: input(
                    step,
                    d.lines ?? step.lines,
                    d.delivery === '__tuesday__' ? isoDate(nextTuesday(Date.parse(`${delivery}T12:00:00Z`))) : step.delivery ? delivery : undefined,
                  ),
                },
              ]
            : undefined;
        await harness.decide({ ctx, principal: s.approver, proposalId: p.id, decision: 'approve', ...(d.kind === 'approve_edited' ? { reason: d.reason } : {}), ...(edits ? { edits } : {}) });
        await markExecuted(s, p.id, clock);
      }
    }
    if (step.thenRaiseCap) {
      const before = policy.rules.find((r) => r.key === 'max_total_value')!;
      policy.rules = policyAt(CAP_AFTER);
      const after = policy.rules.find((r) => r.key === 'max_total_value')!;
      const event: AuditEventInput = {
        type: 'policy.changed',
        actor: s.approver,
        proposalId: null,
        data: { key: 'max_total_value', before: { params: before.params, enabled: before.enabled ?? true }, after: { params: after.params, enabled: after.enabled ?? true } },
      };
      await s.audit.append(AuditEventSchema.parse({ ...event, id: POLICY_EVENT_ID, at: new Date(at(step.thenRaiseCap.days, step.thenRaiseCap.hour, 42)).toISOString() }));
    }
  }
}

function nextTuesday(ms: number): number {
  let t = ms;
  while (new Date(t).getUTCDay() !== 2) t += DAY;
  return t;
}

/** Approved → executed, without writing to Distru: op results + the executor's audit events. */
async function markExecuted(s: Stores, proposalId: string, clock: BackdatedClock): Promise<void> {
  const p = (await s.store.get(proposalId))!;
  const startedAt = new Date(clock.t + 40_000).toISOString();
  const finishedAt = new Date(clock.t + 43_000).toISOString();
  const recordIds = p.ops.map(() => ids());
  const next = ProposalSchema.parse({
    ...p,
    version: p.version + 1,
    status: 'executed',
    updatedAt: finishedAt,
    execution: { startedAt, finishedAt, error: null },
    ops: p.ops.map((op, i) => ({ ...op, status: 'executed', result: { recordId: recordIds[i]!, deduplicated: false, attempts: 1, mismatches: [], error: null, finishedAt } })),
  });
  if (!(await s.store.compareAndSet(next, p.version))) throw new Error(`could not mark ${proposalId} executed`);
  const event = (e: AuditEventInput, when: string) => s.audit.append(AuditEventSchema.parse({ ...e, id: ids(), at: when }));
  await event({ type: 'proposal.execution_started', actor: EXECUTOR_ACTOR, proposalId, data: { resumed: false } }, startedAt);
  for (const [i, op] of next.ops.entries()) {
    await event({ type: 'op.executed', actor: EXECUTOR_ACTOR, proposalId, data: { opIndex: op.index, action: op.action, recordId: recordIds[i]!, idempotencyKey: op.idempotencyKey, attempts: 1 } }, finishedAt);
    await event({ type: 'op.verified', actor: EXECUTOR_ACTOR, proposalId, data: { opIndex: op.index, action: op.action, recordId: recordIds[i]! } }, finishedAt);
  }
  await event({ type: 'proposal.executed', actor: EXECUTOR_ACTOR, proposalId, data: { opCount: next.ops.length } }, finishedAt);
}

/** What @ops/context learns from the history (in-memory context store; nothing persisted). */
async function learn(proposals: Proposal[], events: AuditEvent[]): Promise<{ signals: HarnessSignal[]; memories: Memory[] }> {
  const store = new InMemoryContextStore();
  const syncedAt = new Date(NOW).toISOString();
  const ser = await mock.app.request('http://mock.local/public/v1/companies', { headers: { Authorization: 'Bearer mock-token' } });
  const companies = ((await ser.json()) as { data: unknown[] }).data;
  await store.upsert('company', companies.map((c) => normalizeCompany(c, syncedAt)));
  const products = await ctx.connectors.distru.listAll(ctx.connectors.distru.listProducts, {});
  await store.upsert('product', products.map((p) => normalizeProduct(p, syncedAt)));
  const byId = new Map(proposals.map((p) => [p.id, p]));
  const signals = [...signalsFromAudit(events, { proposal: (id) => byId.get(id) }), ...events.flatMap((e) => policySignalOf(e) ?? [])];
  const out = await ingestHarnessEvents(store, signals, { clock: { now: () => new Date(NOW) } });
  return { signals, memories: out.upserted };
}

const s = DRY_RUN ? await memoryStores() : await databaseStores();
try {
  if (RESET) console.log(`removed ${await s.remove()} seeded proposals (+ ops, approvals, audit events)`);
  const already = await s.existing();
  if (already > 0) console.log(`history already seeded (${already} proposals with meta.seed='${SEED_TAG}'); pass --reset to recreate`);
  else {
    await seed(s);
    console.log(`seeded ${STEPS.length} historical proposals${DRY_RUN ? ' (dry run: in memory only)' : ''}`);
  }
  const { proposals, events } = await s.load();
  const sorted = [...proposals].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  for (const p of sorted) {
    const qty = (ops: Proposal['ops']) => ops.reduce((n, op) => n + ((op.input as { lines?: { quantity: number }[] }).lines ?? []).reduce((m, l) => m + l.quantity, 0), 0);
    const original = Array.isArray(p.meta.originalOps) ? qty(p.meta.originalOps as Proposal['ops']) : null;
    const total = p.ops.reduce((a, op) => a + (op.value ?? 0), 0);
    console.log(
      `  ${p.createdAt.slice(0, 10)}  ${p.status.padEnd(9)} $${Math.round(total).toLocaleString('en-US').padStart(6)}  ${p.title}` +
        (original !== null ? `  (edited: ${original} → ${qty(p.ops)} units)` : '') +
        (p.decision?.reason ? `  — ${p.decision.by.label ?? p.decision.by.id}: "${p.decision.reason.slice(0, 70)}"` : ''),
    );
  }
  console.log(`  audit events: ${events.length}`);
  const { signals, memories } = await learn(proposals, events);
  console.log(`\nWhat @ops/context would learn (${signals.length} signals → ${memories.length} memories):`);
  for (const m of memories.sort((a, b) => a.scope.localeCompare(b.scope) || b.confidence - a.confidence)) {
    console.log(`  [${m.scope}${m.scopeId ? `:${m.scopeId.slice(0, 8)}` : ''}] ${m.key}  conf ${m.confidence}  ${m.statement}`);
  }
} finally {
  await s.done();
}
