/**
 * Dev-only demo data for the Approvals, Audit and Overview pages.
 *
 *   bun scripts/seed-proposals.ts            # add a spread of demo proposals (meta.demo = true)
 *   bun scripts/seed-proposals.ts --clean    # remove every demo proposal and its audit trail
 *   bun scripts/seed-proposals.ts --reset    # clean, then seed again
 *   bun scripts/seed-proposals.ts --execute  # stay running: execute demo proposals once approved in the UI
 *
 * Proposals are created by the real harness (propose → policy → decide → execute → verify → audit)
 * through the agent's Postgres ports, so statuses, diffs, policy reasons and audit events have the
 * exact shapes the agent server serves. The one fake is the ERP: a demo `distru.purchases.upsert`
 * action (same name the policy allowlist expects) that writes to an in-memory store instead of
 * Distru. Never run this against a production database.
 */
import {
  agentPrincipal,
  createHarness,
  defineAction,
  inlineStepRunner,
  matchesExpected,
  mcpClientPrincipal,
  Registry,
  userPrincipal,
  type Clock,
  type Principal,
} from '@ops/harness';
import { z } from 'zod';

process.env.DATABASE_URL ??= 'postgres://ops:ops@127.0.0.1:5482/ops';
// The agent's env module validates its whole contract on import; these values are never used here.
process.env.BETTER_AUTH_SECRET ??= 'seed-script-placeholder-secret-0000000000';

if (process.env.NODE_ENV === 'production') {
  console.error('seed-proposals is dev-only.');
  process.exit(1);
}

const { db, sql } = await import('../../agent/src/db/client');
const { DrizzleProposalStore } = await import('../../agent/src/harness/proposal-store');
const { DrizzleAuditSink } = await import('../../agent/src/harness/audit-sink');
const { DrizzlePolicyRuleSource } = await import('../../agent/src/harness/policy-rules');

// ---------------------------------------------------------------------------------------------
// A tiny fake ERP: vendors, products, existing purchase orders
// ---------------------------------------------------------------------------------------------

const VENDORS: Record<string, string> = {
  'vnd-greenleaf': 'Green Leaf Farms',
  'vnd-sunrise': 'Sunrise Extracts',
  'vnd-coastal': 'Coastal Cultivators',
  'vnd-highdesert': 'High Desert Growers',
};

interface Line {
  id?: string;
  product_id: string;
  location_id: string;
  quantity: number;
  price: number;
}

interface PoPayload {
  id?: string;
  status?: string;
  company_id: string;
  location_id: string;
  description?: string;
  items: Line[];
}

interface PoRecord extends PoPayload {
  id: string;
  purchase_number: string;
  status: string;
}

type Behaviour = 'ok' | 'duplicate' | 'fail' | 'mismatch' | 'slow';

interface DemoCtx {
  behaviour: Behaviour;
}

const erp = new Map<string, PoRecord>();
const byKey = new Map<string, PoRecord>();
let poNumber = 1040;

const existing: PoRecord = {
  id: 'po-1042',
  purchase_number: 'PO-1042',
  status: 'PENDING',
  company_id: 'vnd-coastal',
  location_id: 'loc-oakland',
  description: 'Weekly flower top-up',
  items: [
    { id: 'li-1', product_id: 'prd-lemon-haze-7', location_id: 'loc-oakland', quantity: 40, price: 22 },
    { id: 'li-2', product_id: 'prd-og-preroll', location_id: 'loc-oakland', quantity: 60, price: 9.5 },
    { id: 'li-3', product_id: 'prd-cbd-tincture', location_id: 'loc-oakland', quantity: 12, price: 31 },
  ],
};
erp.set(existing.id, existing);

const LineInput = z.object({ product_id: z.string(), quantity: z.number().positive(), unit_price: z.number().nonnegative() });
const DemoInput = z.object({
  vendor_id: z.string(),
  location_id: z.string(),
  lines: z.array(LineInput).min(1),
  notes: z.string().optional(),
  purchase_id: z.string().optional(),
});
type DemoInput = z.infer<typeof DemoInput>;

const valueOf = (p: PoPayload) => Math.round(p.items.reduce((s, i) => s + i.quantity * i.price, 0) * 100) / 100;
const units = (p: PoPayload) => p.items.reduce((s, i) => s + i.quantity, 0);

const demoPurchaseAction = defineAction<DemoCtx, DemoInput, PoPayload, PoRecord>({
  name: 'distru.purchases.upsert',
  resource: 'purchases',
  risk: 'medium',
  description: 'Demo stand-in for the Distru purchase-order upsert (in-memory ERP).',
  input: DemoInput,
  async loadBefore(_ctx, input) {
    return input.purchase_id ? (erp.get(input.purchase_id) ?? null) : null;
  },
  plan(_ctx, input, before) {
    const ids = new Map(before?.items.map((i) => [i.product_id, i.id]) ?? []);
    const items = input.lines.map((l) => {
      const id = ids.get(l.product_id);
      return { ...(id ? { id } : {}), product_id: l.product_id, location_id: input.location_id, quantity: l.quantity, price: l.unit_price };
    });
    if (before) return { id: before.id, company_id: input.vendor_id, location_id: input.location_id, items };
    return {
      status: 'PENDING',
      company_id: input.vendor_id,
      location_id: input.location_id,
      ...(input.notes ? { description: input.notes } : {}),
      items,
    };
  },
  async execute(ctx, payload, key) {
    if (ctx.behaviour === 'slow') await Bun.sleep(2500);
    if (ctx.behaviour === 'fail') throw Object.assign(new Error('Distru rejected the purchase: vendor license expired'), { code: 'vendor_license_expired' });
    const id = payload.id ?? `po-${++poNumber}`;
    const record: PoRecord = {
      ...(erp.get(id) ?? { purchase_number: `PO-${poNumber}`, status: 'PENDING' }),
      ...payload,
      id,
      purchase_number: erp.get(id)?.purchase_number ?? `PO-${poNumber}`,
      status: payload.status ?? erp.get(id)?.status ?? 'PENDING',
      items: payload.items.map((i, n) => ({ ...i, id: i.id ?? `${id}-li-${n + 1}` })),
    };
    erp.set(id, record);
    byKey.set(key, record);
    return { recordId: id, record };
  },
  async findByIdempotencyKey(ctx, key) {
    if (ctx.behaviour === 'duplicate' && !byKey.has(key)) {
      // A previous attempt already landed in the ERP before a crash: the harness must not write twice.
      const id = `po-${++poNumber}`;
      byKey.set(key, { id, purchase_number: `PO-${poNumber}`, status: 'PENDING', company_id: 'vnd-sunrise', location_id: 'loc-sacramento', items: [] });
    }
    const found = byKey.get(key);
    return found ? { recordId: found.id, record: found } : null;
  },
  async verify(ctx, recordId, expected) {
    const record = erp.get(recordId) ?? byKey.get([...byKey.keys()].find((k) => byKey.get(k)?.id === recordId) ?? '');
    if (ctx.behaviour === 'duplicate') return { ok: true, mismatches: [] };
    if (ctx.behaviour === 'mismatch' && record) {
      // The ERP rounded a unit price on save.
      const tampered = { ...record, items: record.items.map((i, n) => (n === 0 ? { ...i, price: Math.round(i.price) + 1 } : i)) };
      return matchesExpected(tampered, expected);
    }
    return matchesExpected(record, expected);
  },
  valueOf,
  vendorIdsOf: (p) => [p.company_id],
  summarize(input, payload, _ctx, before) {
    const vendor = VENDORS[input.vendor_id] ?? input.vendor_id;
    const lines = payload.items.length;
    return before
      ? `Update ${before.purchase_number} with ${vendor}: ${lines} line${lines === 1 ? '' : 's'}, ${units(payload)} units`
      : `New PO with ${vendor}: ${lines} line${lines === 1 ? '' : 's'}, ${units(payload)} units`;
  },
});

const registry = new Registry<DemoCtx>({ actions: [demoPurchaseAction] });

/** A clock the script moves back in time so seeded proposals have a believable spread of ages. */
let offsetMs = 0;
const clock: Clock = {
  now: () => new Date(Date.now() - offsetMs),
  sleep: (ms) => Bun.sleep(ms),
};

const harness = createHarness<DemoCtx>({
  registry,
  store: new DrizzleProposalStore(db),
  audit: new DrizzleAuditSink(db),
  policyRules: new DrizzlePolicyRuleSource(db),
  clock,
  steps: inlineStepRunner,
  retry: { baseDelayMs: 5, maxDelayMs: 10 },
});

// ---------------------------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------------------------

const planner = agentPrincipal('procurement-planner', 'Procurement Planner');
const claudeCode = mcpClientPrincipal('claude-code', ['read', 'propose'], 'Claude Code (MCP)');

async function demoUser(role: 'operator' | 'approver'): Promise<Principal> {
  const [row] = await sql<{ id: string; name: string }[]>`select id, name from "user" where email = ${`${role}@demo.dev`} limit 1`;
  return userPrincipal(row?.id ?? `demo-${role}`, role, row?.name ?? (role === 'approver' ? 'Demo Approver' : 'Demo Operator'));
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

type Outcome = 'leave' | 'approve' | 'reject' | 'execute';

interface Scenario {
  ageMinutes: number;
  by: 'planner' | 'mcp' | 'operator';
  title: string;
  rationale: string;
  ops: DemoInput[];
  outcome: Outcome;
  behaviour?: Behaviour;
  reason?: string;
}

const line = (product_id: string, quantity: number, unit_price: number) => ({ product_id, quantity, unit_price });

const SCENARIOS: Scenario[] = [
  {
    ageMinutes: 14,
    by: 'planner',
    title: 'Restock Blue Dream and Gelato carts at Oakland',
    rationale: [
      'Two SKUs at **Oakland** fall below their reorder point within 4 days at current velocity.',
      '',
      '| SKU | On hand | Daily velocity | Days of supply |',
      '|---|---|---|---|',
      '| Blue Dream 3.5g | 38 | 11.2 | 3.4 |',
      '| Gelato 1g Cartridge | 22 | 6.8 | 3.2 |',
      '',
      'Green Leaf Farms delivered the last 6 POs in 5 days on average (promised 7), so I sized for 21 days of supply plus lead time.',
      'Compliance Reviewer found passing lab results for both source batches.',
    ].join('\n'),
    ops: [
      {
        vendor_id: 'vnd-greenleaf',
        location_id: 'loc-oakland',
        notes: 'Restock: Blue Dream + Gelato carts',
        lines: [line('prd-bluedream-35', 240, 8.75), line('prd-gelato-cart', 150, 7.2)],
      },
    ],
    outcome: 'leave',
  },
  {
    ageMinutes: 52,
    by: 'planner',
    title: 'Adjust open PO-1042 with Coastal Cultivators',
    rationale:
      'Lemon Haze sold through 40% faster than forecast this week, while CBD tincture velocity dropped to near zero.\n\n- Raise **Lemon Haze 7g** from 40 to 64 units\n- Drop **CBD Tincture 1000mg** (28 days of supply on hand)\n- Keep the pre-roll line unchanged',
    ops: [
      {
        purchase_id: 'po-1042',
        vendor_id: 'vnd-coastal',
        location_id: 'loc-oakland',
        lines: [line('prd-lemon-haze-7', 64, 21.5), line('prd-og-preroll', 60, 9.5)],
      },
    ],
    outcome: 'leave',
  },
  {
    ageMinutes: 190,
    by: 'mcp',
    title: 'Edibles restock for Sacramento and San Jose',
    rationale:
      'Requested from Claude Code: "top up gummies at both stores before the weekend." Two POs with Sunrise Extracts, one per receiving location.',
    ops: [
      { vendor_id: 'vnd-sunrise', location_id: 'loc-sacramento', lines: [line('prd-sour-gummy', 300, 6.4)] },
      { vendor_id: 'vnd-sunrise', location_id: 'loc-sanjose', lines: [line('prd-sour-gummy', 180, 6.4), line('prd-og-preroll', 80, 9.1)] },
    ],
    outcome: 'leave',
  },
  {
    ageMinutes: 35,
    by: 'planner',
    title: 'Small top-up: OG Kush pre-rolls',
    rationale: 'Pre-roll packs at San Jose will run out tomorrow. Small order, under the auto-approve threshold.',
    ops: [{ vendor_id: 'vnd-coastal', location_id: 'loc-sanjose', lines: [line('prd-og-preroll', 36, 9.1)] }],
    outcome: 'execute',
  },
  {
    ageMinutes: 70,
    by: 'planner',
    title: 'CBD tincture sample order',
    rationale: 'Trial order for a new SKU requested by the Oakland store manager.',
    ops: [{ vendor_id: 'vnd-highdesert', location_id: 'loc-oakland', lines: [line('prd-cbd-tincture', 12, 29)] }],
    outcome: 'leave',
  },
  {
    ageMinutes: 300,
    by: 'planner',
    title: 'Quarterly flower pre-buy',
    rationale: 'Locks in Q1 pricing on the top 3 flower SKUs across all locations.',
    ops: [
      {
        vendor_id: 'vnd-greenleaf',
        location_id: 'loc-oakland',
        lines: [line('prd-bluedream-35', 2400, 8.1), line('prd-lemon-haze-7', 600, 20)],
      },
    ],
    outcome: 'leave',
  },
  {
    ageMinutes: 26 * 60,
    by: 'operator',
    title: 'Gelato carts for the San Jose launch event',
    rationale: 'One-off order for the in-store launch on Saturday.',
    ops: [{ vendor_id: 'vnd-sunrise', location_id: 'loc-sanjose', lines: [line('prd-gelato-cart', 400, 7.4)] }],
    outcome: 'reject',
    reason: 'Event was cancelled. Re-propose if it is rescheduled.',
  },
  {
    ageMinutes: 5 * 60,
    by: 'planner',
    title: 'Restock gummies at Sacramento',
    rationale: 'Gummies at Sacramento are 2 days from stock-out. The executor found a PO from an earlier interrupted attempt and reused it.',
    ops: [{ vendor_id: 'vnd-sunrise', location_id: 'loc-sacramento', lines: [line('prd-sour-gummy', 220, 6.4)] }],
    outcome: 'approve',
    behaviour: 'duplicate',
  },
  {
    ageMinutes: 8 * 60,
    by: 'planner',
    title: 'High Desert flower restock',
    rationale: 'Lemon Haze at San Jose below reorder point; High Desert has the best landed cost this month.',
    ops: [{ vendor_id: 'vnd-highdesert', location_id: 'loc-sanjose', lines: [line('prd-lemon-haze-7', 90, 19.5)] }],
    outcome: 'approve',
    behaviour: 'fail',
  },
  {
    ageMinutes: 3 * 60,
    by: 'mcp',
    title: 'Pre-roll restock at Oakland',
    rationale: 'Requested from Claude Code. Read-after-write found the ERP stored a different unit price.',
    ops: [{ vendor_id: 'vnd-coastal', location_id: 'loc-oakland', lines: [line('prd-og-preroll', 120, 9.35)] }],
    outcome: 'approve',
    behaviour: 'mismatch',
  },
  {
    ageMinutes: 20 * 60,
    by: 'planner',
    title: 'Blue Dream restock at San Jose',
    rationale: 'Routine weekly restock.',
    ops: [{ vendor_id: 'vnd-greenleaf', location_id: 'loc-sanjose', lines: [line('prd-bluedream-35', 160, 8.75)] }],
    outcome: 'approve',
  },
];

async function seed() {
  const approver = await demoUser('approver');
  const operator = await demoUser('operator');
  const principals = { planner, mcp: claudeCode, operator };

  for (const s of SCENARIOS) {
    const ctx: DemoCtx = { behaviour: s.behaviour ?? 'ok' };
    offsetMs = s.ageMinutes * 60_000;
    const proposed = await harness.propose({
      ctx,
      principal: principals[s.by],
      title: s.title,
      rationale: s.rationale,
      meta: { demo: true, source: 'seed-proposals' },
      ops: s.ops.map((input) => ({ action: 'distru.purchases.upsert', input })),
    });
    let status = proposed.status;

    if (status === 'pending_approval' && (s.outcome === 'approve' || s.outcome === 'reject')) {
      offsetMs -= 6 * 60_000;
      const decided = await harness.decide({
        ctx,
        principal: approver,
        proposalId: proposed.id,
        decision: s.outcome,
        ...(s.reason ? { reason: s.reason } : {}),
      });
      status = decided.status;
    }
    if (status === 'approved' || (status === 'auto_approved' && s.outcome === 'execute')) {
      offsetMs -= 60_000;
      status = (await harness.execute({ ctx, proposalId: proposed.id })).status;
    }
    console.log(`  ${status.padEnd(16)} ${s.title}`);
  }
}

async function clean() {
  const rows = await sql<{ id: string }[]>`select id from proposal where meta->>'demo' = 'true'`;
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    await sql`delete from audit_event where proposal_id = any(${ids}::uuid[])`;
    await sql`delete from proposal where id = any(${ids}::uuid[])`;
  }
  console.log(`Removed ${ids.length} demo proposal(s).`);
}

/** Plays the durable executor for demo proposals approved in the UI (slowly, so the page shows "Executing"). */
async function executeApproved() {
  console.log('Watching for approved demo proposals (Ctrl+C to stop)…');
  offsetMs = 0;
  for (;;) {
    const rows = await sql<{ id: string; title: string }[]>`
      select id, title from proposal where meta->>'demo' = 'true' and status = 'approved'`;
    for (const row of rows) {
      console.log(`  executing ${row.title}`);
      const done = await harness.execute({ ctx: { behaviour: 'slow' }, proposalId: row.id });
      console.log(`  ${done.status} ${row.title}`);
    }
    await Bun.sleep(1500);
  }
}

const args = new Set(process.argv.slice(2));
try {
  if (args.has('--clean') || args.has('--reset')) await clean();
  if (!args.has('--clean') && !args.has('--execute')) {
    console.log('Seeding demo proposals:');
    await seed();
  }
  if (args.has('--execute')) await executeApproved();
} finally {
  await sql.end({ timeout: 5 });
}
