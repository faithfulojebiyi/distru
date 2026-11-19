/**
 * Live restock demo through the HTTP API (real model, local Distru mock, Inngest dev server):
 *
 *   reset the mocks → operator starts a run → wait for suspension → print the cross-tool proposal (ops per
 *   system, retail-driven picks, allocation-guard caps, policy reasons, vetoed lines, ignored injections)
 *   → approver approves → wait for completion → print POs, buyer caps, vendor emails, receiving tasks,
 *   the run timeline (agents, tokens, cost) and the audit trail.
 *
 * Prereqs (see apps/agent/README.md): Postgres + seed, `bun run dev:mock` (:4500, REST + MCP),
 * `bun run dev:headset` (:4600), the agent server (:4111) with ANTHROPIC_API_KEY, `bun run inngest:dev` (:8288).
 *
 *   bun run restock:demo                         # all locations
 *   bun run restock:demo -- --location "Oakland"  # one location (faster, cheaper)
 *
 * Env: AGENT_URL (default http://localhost:4111), DISTRU_BASE_URL (mock; default http://localhost:4500/public/v1),
 * HEADSET_BASE_URL (default http://localhost:4600), DEMO_TIMEOUT_MS (default 15 min).
 */
export {};

const BASE = process.env.AGENT_URL ?? 'http://localhost:4111';
const MOCK = new URL(process.env.DISTRU_BASE_URL ?? 'http://localhost:4500/public/v1').origin;
const HEADSET = new URL(process.env.HEADSET_BASE_URL ?? 'http://localhost:4600').origin;
const TIMEOUT_MS = Number(process.env.DEMO_TIMEOUT_MS ?? 15 * 60_000);
const ORIGIN = 'http://localhost:3050';

const args = process.argv.slice(2);
const locationArg = args.includes('--location') ? args[args.indexOf('--location') + 1] : undefined;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    [
      'restock:demo runs the real agents, so it needs a model key.',
      'Set ANTHROPIC_API_KEY in apps/agent/.env (and restart the agent server so it picks it up), then run again.',
      'Without a key, `bun test` covers the same workflow end to end with scripted mock models.',
    ].join('\n'),
  );
  process.exit(1);
}

type Json = Record<string, unknown>;
const c = { dim: (s: string) => `\x1b[2m${s}\x1b[0m`, bold: (s: string) => `\x1b[1m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`, red: (s: string) => `\x1b[31m${s}\x1b[0m`, yellow: (s: string) => `\x1b[33m${s}\x1b[0m` };

async function call<T = Json>(path: string, init: RequestInit & { cookie?: string } = {}, base = BASE): Promise<{ status: number; body: T; headers: Headers }> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...(init.cookie ? { Cookie: init.cookie } : {}), ...init.headers },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: res.status, body: body as T, headers: res.headers };
}

function fail(msg: string, detail?: unknown): never {
  console.error(c.red(`✗ ${msg}`));
  if (detail !== undefined) console.error(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2).slice(0, 4000));
  process.exit(1);
}

async function signIn(email: string): Promise<string> {
  const res = await call('/api/auth/sign-in/email', { method: 'POST', body: JSON.stringify({ email, password: 'demo-password' }) });
  if (res.status !== 200) fail(`sign in as ${email} (${res.status}); run \`bun run db:seed\``, res.body);
  return res.headers
    .getSetCookie()
    .map((x) => x.split(';')[0])
    .join('; ');
}

const money = (n: unknown) => (typeof n === 'number' ? `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : 'n/a');
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v.filter((x): x is Json => typeof x === 'object' && x !== null) : []);
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : JSON.stringify(v));

async function waitForRun(cookie: string, runId: string, until: string[]): Promise<Json> {
  const started = Date.now();
  let last = '';
  for (;;) {
    const res = await call<Json>(`/api/runs/${runId}`, { cookie });
    if (res.status === 200) {
      const run = res.body;
      const steps = arr(run.steps)
        .map((s) => `${str(s.stepId)}:${str(s.status)}`)
        .join(' ');
      if (steps !== last) {
        console.log(c.dim(`  [${Math.round((Date.now() - started) / 1000)}s] ${str(run.status)}  ${steps}`));
        last = steps;
      }
      if (until.includes(str(run.status))) return run;
      if (str(run.status) === 'failed') fail(`run failed: ${str(run.error)}`, run.steps);
    } else if (res.status !== 404) {
      fail(`GET /api/runs/${runId} → ${res.status}`, res.body);
    }
    if (Date.now() - started > TIMEOUT_MS) fail(`timed out waiting for ${until.join('|')}; is the Inngest dev server running (bun run inngest:dev)?`);
    await Bun.sleep(2000);
  }
}

function printTimeline(run: Json) {
  console.log(c.bold('\nRun timeline'));
  for (const step of arr(run.steps)) {
    console.log(`  ${str(step.stepId).padEnd(16)} ${str(step.status)}${step.iterations ? ` ×${str(step.iterations)}` : ''}`);
    for (const a of arr(step.agents)) {
      const tokens = obj(a.tokens);
      console.log(
        c.dim(`      ${str(a.agentName)} — ${str(a.label)}: ${str(a.status)}, ${str(tokens.total)} tokens, ~$${Number(a.costUsd ?? 0).toFixed(4)}, tools: ${arr(a.toolCalls).map((t) => str(t.tool)).join(', ') || 'none'}`),
      );
    }
  }
  const totals = obj(run.totals);
  console.log(`  totals: ${str(totals.agentCalls)} agent calls, ${str(totals.toolCalls)} tool calls, ${str(obj(totals.tokens).total)} tokens, ~$${Number(totals.costUsd ?? 0).toFixed(4)} (estimate)`);
}

function printProposal(p: Json) {
  const meta = obj(p.meta);
  console.log(c.bold(`\nProposal ${str(p.id)}`));
  console.log(`  ${str(p.title)}`);
  console.log(`  status ${c.yellow(str(p.status))}, policy ${str(p.policyOutcome)}, total ${money(p.totalValue)}, ${str(p.opCount)} op(s)`);
  const ops = arr(p.ops);
  const bySystem = new Map<string, number>();
  for (const op of ops) bySystem.set(str(op.action).split('.')[0]!, (bySystem.get(str(op.action).split('.')[0]!) ?? 0) + 1);
  console.log(c.bold(`  Ops per system: ${[...bySystem.entries()].map(([k, n]) => `${k} ${n}`).join(', ')}`));
  console.log(c.bold('  Ops in execution order (diff summary)'));
  for (const op of ops) {
    const input = obj(op.input);
    const lines = arr(input.lines);
    console.log(`   #${str(op.index)} ${c.dim(str(op.action).padEnd(26))} ${str(op.summary)} [${str(op.risk)} risk, ${arr(op.diff).length} field changes]`);
    for (const l of lines) console.log(c.dim(`       ${str(l.product_id).slice(0, 8)}… × ${str(l.quantity)} @ ${money(l.unit_price)}`));
  }
  const atRisk = arr(meta.atRisk);
  const retail = atRisk.filter((a) => str(a.flagged_by) !== 'wholesale' || ['surging', 'rising'].includes(str(a.retail_signal)));
  console.log(c.bold(`  Retail-driven picks (${retail.length} of ${atRisk.length} at-risk SKU rows)`));
  for (const a of retail) {
    console.log(`   ${str(a.sku).padEnd(12)} ${str(a.location).padEnd(32)} flagged_by=${str(a.flagged_by)} Distru ${str(a.reorder_status)} ${str(a.days_of_supply)}d → adjusted ${str(a.adjusted_days_of_supply)}d, retail ${str(a.retail_signal)} ${str(a.retail_growth_3w_pct)}% (${str(a.recommendation)})`);
  }
  const guard = arr(meta.allocationGuard);
  console.log(c.bold(`  Allocation guard (${guard.length} computed cap(s); ${guard.filter((g) => !str(g.status).startsWith('dropped')).length} in the proposal)`));
  for (const g of guard) console.log(`   [${str(g.status)}] ${str(g.reason)}`);
  console.log(c.bold('  Policy reasons'));
  for (const r of arr(obj(p.policy).reasons)) console.log(`   ${str(r.outcome).padEnd(14)} ${str(r.rule)}: ${str(r.message)}`);
  const vetoed = arr(meta.vetoedLines);
  console.log(c.bold(`  Vetoed lines (${vetoed.length})`));
  for (const v of vetoed) console.log(`   ${c.red(str(v.sku ?? v.product_id))} ×${str(v.quantity)} (${str(v.source)}): ${Array.isArray(v.reasons) ? v.reasons.map(str).join('; ') : ''}`);
  const suspicious = arr(meta.suspiciousText);
  console.log(c.bold(`  Ignored suspicious ERP text (${suspicious.length})`));
  for (const s of suspicious) console.log(`   ${str(s.sku ?? s.product_id)} [${str(s.source)}]: "${str(s.excerpt).slice(0, 100)}"`);
  const critiques = arr(meta.critiques);
  if (critiques.length) {
    console.log(c.bold(`  Policy revisions (${str(meta.revisions)})`));
    for (const cq of critiques) console.log(`   round ${str(cq.round)}: ${str(cq.explanation).slice(0, 300)}`);
  }
}

// ── 1. reset the mock ────────────────────────────────────────────────────────────────────────────
const reset = await call('/__mock/reset', { method: 'POST', body: JSON.stringify({ scenario: 'default' }) }, MOCK);
if (reset.status !== 200) fail(`reset the Distru mock at ${MOCK} (${reset.status}); start it with \`bun run dev:mock\``, reset.body);
const resetHeadset = await call('/__mock/reset', { method: 'POST', body: JSON.stringify({ scenario: 'default' }) }, HEADSET);
if (resetHeadset.status !== 200) fail(`reset the Headset mock at ${HEADSET} (${resetHeadset.status}); start it with \`bun run dev:headset\``, resetHeadset.body);
console.log(c.green(`✓ mocks reset (Distru ${MOCK}, Headset ${HEADSET}, scenario default)`));
const connectors = await call<{ items: Array<{ id: string; health: { ok: boolean; detail: string | null } }> }>('/api/connectors', { cookie: await signIn('operator@demo.dev') });
if (connectors.status === 200) console.log(`  connectors: ${connectors.body.items.map((x) => `${x.id} ${x.health.ok ? c.green('ok') : c.red('down')} (${x.health.detail ?? ''})`).join('; ')}`);

// ── 2. operator starts a run ─────────────────────────────────────────────────────────────────────
const operator = await signIn('operator@demo.dev');
let locationIds: string[] | undefined;
if (locationArg) {
  const state = await call<{ locations: Array<{ id: string; name: string }> }>('/__mock/state', {}, MOCK);
  const loc = state.body.locations.find((l) => l.name.toLowerCase().includes(locationArg.toLowerCase()));
  if (!loc) fail(`no location matching "${locationArg}"`, state.body.locations);
  locationIds = [loc.id];
  console.log(`  scope: ${loc.name}`);
}
const started = await call<{ runId: string }>('/api/runs', {
  method: 'POST',
  cookie: operator,
  body: JSON.stringify({ scenarioNote: 'Demo: restock anything at risk before the weekend.', ...(locationIds ? { locationIds } : {}) }),
});
if (started.status !== 202) fail(`POST /api/runs → ${started.status}`, started.body);
const { runId } = started.body;
console.log(c.green(`✓ run started as operator: ${runId}`));

// ── 3. wait for the decision point ───────────────────────────────────────────────────────────────
let run = await waitForRun(operator, runId, ['suspended', 'success']);
const proposalId = str(obj(run.proposal).id);
if (!proposalId) {
  printTimeline(run);
  console.log(c.yellow(`\nRun finished without a proposal: ${str(obj(run.result).message)}`));
  process.exit(0);
}
const proposal = (await call<Json>(`/api/proposals/${proposalId}`, { cookie: operator })).body;
printProposal(proposal);

// ── 4. approver decides ──────────────────────────────────────────────────────────────────────────
if (str(run.status) === 'suspended') {
  const approver = await signIn('approver@demo.dev');
  const decided = await call(`/api/proposals/${proposalId}/decision`, {
    method: 'POST',
    cookie: approver,
    body: JSON.stringify({ decision: 'approve', reason: 'Demo approval' }),
  });
  if (decided.status !== 200) fail(`approve → ${decided.status}`, decided.body);
  console.log(c.green('\n✓ approved as approver; the run resumes'));
  run = await waitForRun(operator, runId, ['success']);
} else if (str(proposal.status) === 'denied') {
  console.log(c.yellow('\n✗ policy still denies the proposal after the revision rounds; it was recorded for review and cannot execute'));
} else {
  console.log(c.green(`\n✓ policy auto-approved the proposal (${str(proposal.status)}); no human decision needed`));
}

// ── 5. outcome ───────────────────────────────────────────────────────────────────────────────────
const result = obj(run.result);
printTimeline(run);
console.log(c.bold('\nResult'));
console.log(`  ${str(result.status)}: ${str(result.message)}`);
const poIds = Array.isArray(result.purchaseOrderIds) ? result.purchaseOrderIds.map(str) : [];
console.log(`  purchase orders: ${poIds.join(', ') || 'none'}`);
const mockState = (await call<{ recent_purchases: Array<{ id: string; purchase_number: string; status: string; total: string }> }>('/__mock/state', {}, MOCK)).body;
const ids = new Set(poIds);
for (const po of mockState.recent_purchases.filter((p) => ids.has(p.id))) console.log(`   ${po.purchase_number} ${po.id} ${po.status} $${po.total}`);

// Cross-tool outcome, read back from each system.
const finalProposal = (await call<Json>(`/api/proposals/${proposalId}`, { cookie: operator })).body;
const finalOps = arr(finalProposal.ops);
const resolvedText = (text: string, resolved: Json) => Object.entries(resolved).reduce((t, [k, v]) => t.split(k).join(str(v)), text);
console.log(c.bold('\nOps per system (status)'));
for (const op of finalOps) {
  const result = obj(op.result);
  const resolved = obj(result.resolved);
  const refs = Object.keys(resolved).length ? c.dim(` resolved ${Object.entries(resolved).map(([k, v]) => `${k}→${str(v)}`).join(', ')}`) : '';
  console.log(`  #${str(op.index)} ${str(op.action).padEnd(26)} ${str(op.status).padEnd(8)} ${str(result.recordId)}${result.deduplicated ? ' (dedup)' : ''}${arr(result.mismatches).length ? c.red(' MISMATCH') : ''}${refs}`);
}
const caps = (await call<{ buyer_caps: Array<{ sku: string; max_menu_buyer_order_quantity: number }> }>('/__mock/state', {}, MOCK)).body.buyer_caps;
console.log(c.bold(`\nBuyer caps in Distru (via MCP mutate-product): ${caps.map((b) => `${b.sku}=${b.max_menu_buyer_order_quantity}/order`).join(', ') || 'none'}`));
console.log(c.bold('Vendor emails (mock outbox; subject as sent)'));
for (const op of finalOps.filter((o) => str(o.action) === 'email.send_vendor_po')) {
  const payload = obj(op.payload);
  const resolved = obj(obj(op.result).resolved);
  console.log(`  ${str(obj(op.result).recordId)} → ${arr(payload.to).map(str).join(', ') || str(payload.to)}: "${resolvedText(str(payload.subject), resolved)}"`);
}
console.log(c.bold('Receiving tasks (Distru REST, read back)'));
for (const op of finalOps.filter((o) => str(o.action) === 'distru.tasks.create')) {
  const id = str(obj(op.result).recordId);
  if (!id) continue;
  const task = obj((await call<Json>(`/public/v1/tasks/${id}`, { headers: { Authorization: 'Bearer mock-token' } }, MOCK)).body.data);
  console.log(`  ${str(task.name)} → ${str(obj(task.owner).full_name)}, linked ${str(obj(task.purchase).purchase_number)}, due ${str(task.due_datetime).slice(0, 10)}`);
}

const audit = (await call<{ items: Json[] }>(`/api/audit-events?proposalId=${proposalId}&order=asc&limit=200`, { cookie: operator })).body;
console.log(c.bold('\nAudit trail'));
for (const e of audit.items) {
  const actor = obj(e.actor);
  console.log(`  ${str(e.at).slice(11, 19)} ${str(e.type).padEnd(28)} ${str(actor.kind)}:${str(actor.label ?? actor.id)}${e.opIndex !== null ? ` op#${str(e.opIndex)}` : ''}`);
}
console.log(c.green(`\n✓ demo complete (run ${runId}, proposal ${proposalId})`));
